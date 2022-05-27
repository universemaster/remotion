import fs, {statSync} from 'fs';
import path from 'path';
import {Browser as PuppeteerBrowser} from 'puppeteer-core';
import {
	BrowserExecutable,
	FfmpegExecutable,
	Internals,
	StillImageFormat,
	TCompMetadata,
} from 'remotion';
import {RenderMediaOnDownload} from './assets/download-and-map-assets-to-file';
import {ensureOutputDirectory} from './ensure-output-directory';
import {handleJavascriptException} from './error-handling/handle-javascript-exception';
import {
	getServeUrlWithFallback,
	ServeUrlOrWebpackBundle,
} from './legacy-webpack-config';
import {makeAssetsDownloadTmpDir} from './make-assets-download-dir';
import {ChromiumOptions, openBrowser} from './open-browser';
import {prepareServer} from './prepare-server';
import {provideScreenshot} from './provide-screenshot';
import {puppeteerEvaluateWithCatch} from './puppeteer-evaluate';
import {seekToFrame} from './seek-to-frame';
import {setPropsAndEnv} from './set-props-and-env';
import {validatePuppeteerTimeout} from './validate-puppeteer-timeout';
import {validateScale} from './validate-scale';

type InnerStillOptions = {
	composition: TCompMetadata;
	output: string;
	frame?: number;
	inputProps?: unknown;
	imageFormat?: StillImageFormat;
	quality?: number;
	puppeteerInstance?: PuppeteerBrowser;
	dumpBrowserLogs?: boolean;
	envVariables?: Record<string, string>;
	overwrite?: boolean;
	browserExecutable?: BrowserExecutable;
	timeoutInMilliseconds?: number;
	chromiumOptions?: ChromiumOptions;
	scale?: number;
	onDownload?: RenderMediaOnDownload;
	ffmpegExecutable?: FfmpegExecutable;
};

type RenderStillOptions = InnerStillOptions &
	ServeUrlOrWebpackBundle & {
		port?: number | null;
	};

const innerRenderStill = async ({
	composition,
	quality,
	imageFormat = 'png',
	serveUrl,
	puppeteerInstance,
	dumpBrowserLogs = false,
	onError,
	inputProps,
	envVariables,
	output,
	frame = 0,
	overwrite = true,
	browserExecutable,
	timeoutInMilliseconds,
	chromiumOptions,
	scale,
	proxyPort,
}: InnerStillOptions & {
	serveUrl: string;
	onError: (err: Error) => void;
	proxyPort: number;
}): Promise<void> => {
	Internals.validateDimension(
		composition.height,
		'height',
		'in the `config` object passed to `renderStill()`'
	);
	Internals.validateDimension(
		composition.width,
		'width',
		'in the `config` object passed to `renderStill()`'
	);
	Internals.validateFps(
		composition.fps,
		'in the `config` object of `renderStill()`'
	);
	Internals.validateDurationInFrames(
		composition.durationInFrames,
		'in the `config` object passed to `renderStill()`'
	);
	Internals.validateNonNullImageFormat(imageFormat);
	Internals.validateFrame(frame, composition.durationInFrames);
	validatePuppeteerTimeout(timeoutInMilliseconds);
	validateScale(scale);

	if (typeof output !== 'string') {
		throw new TypeError('`output` parameter was not passed or is not a string');
	}

	output = path.resolve(process.cwd(), output);

	if (quality !== undefined && imageFormat !== 'jpeg') {
		throw new Error(
			"You can only pass the `quality` option if `imageFormat` is 'jpeg'."
		);
	}

	Internals.validateQuality(quality);

	if (fs.existsSync(output)) {
		if (!overwrite) {
			throw new Error(
				`Cannot render still - "overwrite" option was set to false, but the output destination ${output} already exists.`
			);
		}

		const stat = statSync(output);

		if (!stat.isFile()) {
			throw new Error(
				`The output location ${output} already exists, but is not a file, but something else (e.g. folder). Cannot save to it.`
			);
		}
	}

	ensureOutputDirectory(output);

	const browserInstance =
		puppeteerInstance ??
		(await openBrowser(Internals.DEFAULT_BROWSER, {
			browserExecutable,
			shouldDumpIo: dumpBrowserLogs,
			chromiumOptions,
			forceDeviceScaleFactor: scale ?? 1,
		}));
	const page = await browserInstance.newPage();
	page.setViewport({
		width: composition.width,
		height: composition.height,
		deviceScaleFactor: scale ?? 1,
	});

	const cleanup = async () => {
		cleanUpJSException();

		if (puppeteerInstance) {
			await page.close();
		} else {
			browserInstance.close().catch((err) => {
				console.log('Unable to close browser', err);
			});
		}
	};

	const errorCallback = (err: Error) => {
		onError(err);
		cleanup();
	};

	const cleanUpJSException = handleJavascriptException({
		page,
		onError: errorCallback,
		frame: null,
	});
	await setPropsAndEnv({
		inputProps,
		envVariables,
		page,
		serveUrl,
		initialFrame: frame,
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
	await seekToFrame({frame, page});

	await provideScreenshot({
		page,
		imageFormat,
		quality,
		options: {
			frame,
			output,
		},
	});

	await cleanup();
};

/**
 * @description Render a still frame from a composition and returns an image path
 */
export const renderStill = (options: RenderStillOptions): Promise<void> => {
	const selectedServeUrl = getServeUrlWithFallback(options);

	const downloadDir = makeAssetsDownloadTmpDir();

	const onDownload = options.onDownload ?? (() => () => undefined);

	return new Promise((resolve, reject) => {
		const onError = (err: Error) => reject(err);

		let close: (() => void) | null = null;

		prepareServer({
			webpackConfigOrServeUrl: selectedServeUrl,
			downloadDir,
			onDownload,
			onError,
			ffmpegExecutable: options.ffmpegExecutable ?? null,
			port: options.port ?? null,
		})
			.then(({serveUrl, closeServer, offthreadPort}) => {
				close = closeServer;
				return innerRenderStill({
					...options,
					serveUrl,
					onError: (err) => reject(err),
					proxyPort: offthreadPort,
				});
			})

			.then((res) => resolve(res))
			.catch((err) => reject(err))
			.finally(() => close?.());
	});
};
