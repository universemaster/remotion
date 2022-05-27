import fs from 'fs';
import path from 'path';
import {
	Browser as PuppeteerBrowser,
	ConsoleMessage,
	Page,
} from 'puppeteer-core';
import {
	BrowserExecutable,
	FfmpegExecutable,
	FrameRange,
	ImageFormat,
	Internals,
	SmallTCompMetadata,
	TAsset,
} from 'remotion';
import {
	downloadAndMapAssetsToFileUrl,
	RenderMediaOnDownload,
} from './assets/download-and-map-assets-to-file';
import {BrowserLog} from './browser-log';
import {cycleBrowserTabs} from './cycle-browser-tabs';
import {handleJavascriptException} from './error-handling/handle-javascript-exception';
import {getActualConcurrency} from './get-concurrency';
import {getDurationFromFrameRange} from './get-duration-from-frame-range';
import {getRealFrameRange} from './get-frame-to-render';
import {DEFAULT_IMAGE_FORMAT} from './image-format';
import {
	getServeUrlWithFallback,
	ServeUrlOrWebpackBundle,
} from './legacy-webpack-config';
import {makeAssetsDownloadTmpDir} from './make-assets-download-dir';
import {ChromiumOptions, openBrowser} from './open-browser';
import {Pool} from './pool';
import {prepareServer} from './prepare-server';
import {provideScreenshot} from './provide-screenshot';
import {puppeteerEvaluateWithCatch} from './puppeteer-evaluate';
import {seekToFrame} from './seek-to-frame';
import {setPropsAndEnv} from './set-props-and-env';
import {OnStartData, RenderFramesOutput} from './types';
import {validateScale} from './validate-scale';

type ConfigOrComposition =
	| {
			/**
			 * @deprecated This field has been renamed to `composition`
			 */
			config: SmallTCompMetadata;
	  }
	| {
			composition: SmallTCompMetadata;
	  };

type RenderFramesOptions = {
	onStart: (data: OnStartData) => void;
	onFrameUpdate: (framesRendered: number, frameIndex: number) => void;
	outputDir: string | null;
	inputProps: unknown;
	envVariables?: Record<string, string>;
	imageFormat: ImageFormat;
	parallelism?: number | null;
	quality?: number;
	frameRange?: FrameRange | null;
	dumpBrowserLogs?: boolean;
	puppeteerInstance?: PuppeteerBrowser;
	browserExecutable?: BrowserExecutable;
	onBrowserLog?: (log: BrowserLog) => void;
	onFrameBuffer?: (buffer: Buffer, frame: number) => void;
	onDownload?: RenderMediaOnDownload;
	timeoutInMilliseconds?: number;
	chromiumOptions?: ChromiumOptions;
	scale?: number;
	ffmpegExecutable?: FfmpegExecutable;
	port?: number | null;
} & ConfigOrComposition &
	ServeUrlOrWebpackBundle;

const getComposition = (others: ConfigOrComposition) => {
	if ('composition' in others) {
		return others.composition;
	}

	if ('config' in others) {
		return others.config;
	}

	return undefined;
};

const innerRenderFrames = async ({
	onFrameUpdate,
	outputDir,
	onStart,
	inputProps,
	quality,
	imageFormat = DEFAULT_IMAGE_FORMAT,
	frameRange,
	puppeteerInstance,
	onError,
	envVariables,
	onBrowserLog,
	onFrameBuffer,
	onDownload,
	pagesArray,
	serveUrl,
	composition,
	timeoutInMilliseconds,
	scale,
	actualParallelism,
	downloadDir,
	proxyPort,
}: Omit<RenderFramesOptions, 'url' | 'onDownload'> & {
	onError: (err: Error) => void;
	pagesArray: Page[];
	serveUrl: string;
	composition: SmallTCompMetadata;
	actualParallelism: number;
	downloadDir: string;
	onDownload: RenderMediaOnDownload;
	proxyPort: number;
}): Promise<RenderFramesOutput> => {
	if (!puppeteerInstance) {
		throw new Error('weird');
	}

	if (outputDir) {
		if (!fs.existsSync(outputDir)) {
			fs.mkdirSync(outputDir, {
				recursive: true,
			});
		}
	}

	const realFrameRange = getRealFrameRange(
		composition.durationInFrames,
		frameRange ?? null
	);

	const frameCount = getDurationFromFrameRange(
		realFrameRange,
		composition.durationInFrames
	);

	const pages = new Array(actualParallelism).fill(true).map(async () => {
		const page = await puppeteerInstance.newPage();
		pagesArray.push(page);
		page.setViewport({
			width: composition.width,
			height: composition.height,
			deviceScaleFactor: scale ?? 1,
		});

		const logCallback = (log: ConsoleMessage) => {
			onBrowserLog?.({
				stackTrace: log.stackTrace(),
				text: log.text(),
				type: log.type(),
			});
		};

		if (onBrowserLog) {
			page.on('console', logCallback);
		}

		const initialFrame =
			typeof frameRange === 'number'
				? frameRange
				: frameRange === null || frameRange === undefined
				? 0
				: frameRange[0];

		await setPropsAndEnv({
			inputProps,
			envVariables,
			page,
			serveUrl,
			initialFrame,
			timeoutInMilliseconds,
			proxyPort,
		});

		await puppeteerEvaluateWithCatch({
			pageFunction: (id: string) => {
				window.setBundleMode({
					type: 'composition',
					compositionName: id,
				});
			},
			args: [composition.id],
			frame: null,
			page,
		});

		page.off('console', logCallback);
		return page;
	});

	const puppeteerPages = await Promise.all(pages);
	const pool = new Pool(puppeteerPages);

	const [firstFrameIndex, lastFrameIndex] = realFrameRange;
	// Substract one because 100 frames will be 00-99
	// --> 2 digits
	const filePadLength = String(lastFrameIndex).length;
	let framesRendered = 0;

	onStart({
		frameCount,
	});
	const assets: TAsset[][] = new Array(frameCount).fill(undefined);
	await Promise.all(
		new Array(frameCount)
			.fill(Boolean)
			.map((x, i) => i)
			.map(async (index) => {
				const frame = realFrameRange[0] + index;
				const freePage = await pool.acquire();
				const paddedIndex = String(frame).padStart(filePadLength, '0');

				const errorCallbackOnFrame = (err: Error) => {
					onError(err);
				};

				const cleanupPageError = handleJavascriptException({
					page: freePage,
					onError: errorCallbackOnFrame,
					frame,
				});
				freePage.on('error', errorCallbackOnFrame);
				await seekToFrame({frame, page: freePage});

				if (imageFormat !== 'none') {
					if (onFrameBuffer) {
						const buffer = await provideScreenshot({
							page: freePage,
							imageFormat,
							quality,
							options: {
								frame,
								output: undefined,
							},
						});
						onFrameBuffer(buffer, frame);
					} else {
						if (!outputDir) {
							throw new Error(
								'Called renderFrames() without specifying either `outputDir` or `onFrameBuffer`'
							);
						}

						const output = path.join(
							outputDir,
							`element-${paddedIndex}.${imageFormat}`
						);
						await provideScreenshot({
							page: freePage,
							imageFormat,
							quality,
							options: {
								frame,
								output,
							},
						});
					}
				}

				const collectedAssets = await puppeteerEvaluateWithCatch<TAsset[]>({
					pageFunction: () => {
						return window.remotion_collectAssets();
					},
					args: [],
					frame,
					page: freePage,
				});
				const compressedAssets = collectedAssets.map((asset) =>
					Internals.AssetCompression.compressAsset(
						assets.filter(Internals.truthy).flat(1),
						asset
					)
				);
				assets[index] = compressedAssets;
				compressedAssets.forEach((asset) => {
					downloadAndMapAssetsToFileUrl({
						asset,
						downloadDir,
						onDownload,
					}).catch((err) => {
						onError(
							new Error(
								`Error while downloading asset: ${(err as Error).stack}`
							)
						);
					});
				});
				pool.release(freePage);
				framesRendered++;
				onFrameUpdate(framesRendered, frame);
				cleanupPageError();
				freePage.off('error', errorCallbackOnFrame);
				return compressedAssets;
			})
	);

	const returnValue: RenderFramesOutput = {
		assetsInfo: {
			assets,
			downloadDir,
			firstFrameIndex,
			imageSequenceName: `element-%0${filePadLength}d.${imageFormat}`,
		},
		frameCount,
	};
	return returnValue;
};

export const renderFrames = async (
	options: RenderFramesOptions
): Promise<RenderFramesOutput> => {
	const composition = getComposition(options);

	if (!composition) {
		throw new Error(
			'No `composition` option has been specified for renderFrames()'
		);
	}

	Internals.validateDimension(
		composition.height,
		'height',
		'in the `config` object passed to `renderFrames()`'
	);
	Internals.validateDimension(
		composition.width,
		'width',
		'in the `config` object passed to `renderFrames()`'
	);
	Internals.validateFps(
		composition.fps,
		'in the `config` object of `renderFrames()`'
	);
	Internals.validateDurationInFrames(
		composition.durationInFrames,
		'in the `config` object passed to `renderFrames()`'
	);
	if (options.quality !== undefined && options.imageFormat !== 'jpeg') {
		throw new Error(
			"You can only pass the `quality` option if `imageFormat` is 'jpeg'."
		);
	}

	const selectedServeUrl = getServeUrlWithFallback(options);

	Internals.validateQuality(options.quality);
	validateScale(options.scale);

	const browserInstance =
		options.puppeteerInstance ??
		(await openBrowser(Internals.DEFAULT_BROWSER, {
			shouldDumpIo: options.dumpBrowserLogs,
			browserExecutable: options.browserExecutable,
			chromiumOptions: options.chromiumOptions,
			forceDeviceScaleFactor: options.scale ?? 1,
		}));

	const downloadDir = makeAssetsDownloadTmpDir();

	const onDownload = options.onDownload ?? (() => () => undefined);

	const actualParallelism = getActualConcurrency(options.parallelism ?? null);

	const {stopCycling} = cycleBrowserTabs(browserInstance, actualParallelism);

	const openedPages: Page[] = [];

	return new Promise<RenderFramesOutput>((resolve, reject) => {
		let cleanup: (() => void) | null = null;
		const onError = (err: Error) => reject(err);
		prepareServer({
			webpackConfigOrServeUrl: selectedServeUrl,
			downloadDir,
			onDownload,
			onError,
			ffmpegExecutable: options.ffmpegExecutable ?? null,
			port: options.port ?? null,
		})
			.then(({serveUrl, closeServer, offthreadPort}) => {
				cleanup = closeServer;
				return innerRenderFrames({
					...options,
					puppeteerInstance: browserInstance,
					onError,
					pagesArray: openedPages,
					serveUrl,
					composition,
					actualParallelism,
					onDownload,
					downloadDir,
					proxyPort: offthreadPort,
				});
			})
			.then((res) => resolve(res))
			.catch((err) => reject(err))
			.finally(() => {
				// If browser instance was passed in, we close all the pages
				// we opened.
				// If new browser was opened, then closing the browser as a cleanup.

				if (options.puppeteerInstance) {
					Promise.all(openedPages.map((p) => p.close())).catch((err) => {
						console.log('Unable to close browser tab', err);
					});
				} else {
					browserInstance.close().catch((err) => {
						console.log('Unable to close browser', err);
					});
				}

				stopCycling();
				cleanup?.();
			});
	});
};
