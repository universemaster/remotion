import {
	getCompositions,
	openBrowser,
	RenderInternals,
	RenderMediaOnDownload,
	renderStill,
} from '@remotion/renderer';
import chalk from 'chalk';
import {mkdirSync} from 'fs';
import path from 'path';
import {Config, Internals} from 'remotion';
import {getCliOptions} from './get-cli-options';
import {getCompositionId} from './get-composition-id';
import {initializeRenderCli} from './initialize-render-cli';
import {Log} from './log';
import {parsedCli, quietFlagProvided} from './parse-command-line';
import {
	createOverwriteableCliOutput,
	DownloadProgress,
	makeRenderingAndStitchingProgress,
} from './progress-bar';
import {bundleOnCli} from './setup-cache';
import {RenderStep} from './step';
import {getUserPassedOutputLocation} from './user-passed-output-location';

export const still = async () => {
	const startTime = Date.now();
	const file = parsedCli._[1];
	const fullPath = RenderInternals.isServeUrl(file)
		? file
		: path.join(process.cwd(), file);

	await initializeRenderCli('still');

	const userOutput = path.resolve(process.cwd(), getUserPassedOutputLocation());

	if (userOutput.endsWith('.jpeg') || userOutput.endsWith('.jpg')) {
		Log.verbose(
			'Output file has a JPEG extension, therefore setting the image format to JPEG.'
		);
		Config.Rendering.setImageFormat('jpeg');
	}

	if (userOutput.endsWith('.png')) {
		Log.verbose(
			'Output file has a PNG extension, therefore setting the image format to PNG.'
		);
		Config.Rendering.setImageFormat('png');
	}

	const {
		inputProps,
		envVariables,
		quality,
		browser,
		imageFormat,
		stillFrame,
		browserExecutable,
		chromiumOptions,
		scale,
		ffmpegExecutable,
		overwrite,
		puppeteerTimeout,
		port,
	} = await getCliOptions({isLambda: false, type: 'still'});

	Log.verbose('Browser executable: ', browserExecutable);

	if (imageFormat === 'none') {
		Log.error(
			'No image format was selected - this is probably an error in Remotion - please post your command on Github Issues for help.'
		);
		process.exit(1);
	}

	if (imageFormat === 'png' && !userOutput.endsWith('.png')) {
		Log.warn(
			`Rendering a PNG, expected a .png extension but got ${userOutput}`
		);
	}

	if (
		imageFormat === 'jpeg' &&
		!userOutput.endsWith('.jpg') &&
		!userOutput.endsWith('.jpeg')
	) {
		Log.warn(
			`Rendering a JPEG, expected a .jpg or .jpeg extension but got ${userOutput}`
		);
	}

	const browserInstance = openBrowser(browser, {
		browserExecutable,
		chromiumOptions,

		shouldDumpIo: Internals.Logging.isEqualOrBelowLogLevel(
			Internals.Logging.getLogLevel(),
			'verbose'
		),
		forceDeviceScaleFactor: scale,
	});

	mkdirSync(path.join(userOutput, '..'), {
		recursive: true,
	});

	const steps: RenderStep[] = [
		RenderInternals.isServeUrl(fullPath) ? null : ('bundling' as const),
		'rendering' as const,
	].filter(Internals.truthy);

	const urlOrBundle = RenderInternals.isServeUrl(fullPath)
		? Promise.resolve(fullPath)
		: await bundleOnCli(fullPath, steps);

	const puppeteerInstance = await browserInstance;
	const comps = await getCompositions(await urlOrBundle, {
		inputProps,
		puppeteerInstance,
		envVariables,
		timeoutInMilliseconds: puppeteerTimeout,
		chromiumOptions,
		port,
		browserExecutable,
		ffmpegExecutable,
	});
	const compositionId = getCompositionId(comps);

	const composition = comps.find((c) => c.id === compositionId);
	if (!composition) {
		throw new Error(`Cannot find composition with ID ${compositionId}`);
	}

	const renderProgress = createOverwriteableCliOutput(quietFlagProvided());
	const renderStart = Date.now();

	const downloads: DownloadProgress[] = [];
	let frames = 0;
	const totalFrames = 1;

	const updateProgress = () => {
		renderProgress.update(
			makeRenderingAndStitchingProgress({
				rendering: {
					frames,
					concurrency: 1,
					doneIn: frames === totalFrames ? Date.now() - renderStart : null,
					steps,
					totalFrames,
				},
				downloads,
				stitching: null,
			})
		);
	};

	updateProgress();

	const onDownload: RenderMediaOnDownload = (src) => {
		const id = Math.random();
		const download: DownloadProgress = {
			id,
			name: src,
			progress: 0,
		};
		downloads.push(download);
		updateProgress();

		return ({percent}) => {
			download.progress = percent;
			updateProgress();
		};
	};

	await renderStill({
		composition,
		frame: stillFrame,
		output: userOutput,
		serveUrl: await urlOrBundle,
		quality,
		dumpBrowserLogs: Internals.Logging.isEqualOrBelowLogLevel(
			Internals.Logging.getLogLevel(),
			'verbose'
		),
		envVariables,
		imageFormat,
		inputProps,
		chromiumOptions,
		timeoutInMilliseconds: Internals.getCurrentPuppeteerTimeout(),
		scale,
		ffmpegExecutable,
		browserExecutable,
		overwrite,
		onDownload,
	});

	frames = 1;
	updateProgress();
	Log.info();

	const closeBrowserPromise = puppeteerInstance.close();

	Log.info(chalk.green('\nYour still frame is ready!'));

	const seconds = Math.round((Date.now() - startTime) / 1000);
	Log.info(
		[
			'- Total render time:',
			seconds,
			seconds === 1 ? 'second' : 'seconds',
		].join(' ')
	);
	Log.info('-', 'Output can be found at:');
	Log.info(chalk.cyan(`▶️ ${userOutput}`));
	await closeBrowserPromise;
};
