import minimist from 'minimist';
import {resolve} from 'path';
import {
	BrowserExecutable,
	Codec,
	Config,
	FfmpegExecutable,
	ImageFormat,
	Internals,
	LogLevel,
	OpenGlRenderer,
	PixelFormat,
	ProResProfile,
} from 'remotion';
import {Log} from './log';

export type CommandLineOptions = {
	['browser-executable']: BrowserExecutable;
	['ffmpeg-executable']: FfmpegExecutable;
	['pixel-format']: PixelFormat;
	['image-format']: ImageFormat;
	['prores-profile']: ProResProfile;
	['bundle-cache']: string;
	['env-file']: string;
	['ignore-certificate-errors']: string;
	['disable-web-security']: string;
	['skip-n-frames']: number;
	codec: Codec;
	concurrency: number;
	timeout: number;
	config: string;
	crf: number;
	force: boolean;
	overwrite: boolean;
	png: boolean;
	props: string;
	quality: number;
	frames: string | number;
	scale: number;
	sequence: boolean;
	quiet: boolean;
	q: boolean;
	log: string;
	help: boolean;
	port: number;
	frame: string | number;
	['disable-headless']: boolean;
	gl: OpenGlRenderer;
};

export const BooleanFlags = [
	'force',
	'overwrite',
	'sequence',
	'help',
	'quiet',
	'q',
	// Lambda flags
	'force',
	'disable-chunk-optimization',
	'save-browser-logs',
	'disable-cloudwatch',
	'yes',
	'y',
	'disable-web-security',
	'ignore-certificate-errors',
	'disable-headless',
];

export const parsedCli = minimist<CommandLineOptions>(process.argv.slice(2), {
	boolean: BooleanFlags,
});

export const parseCommandLine = (
	type: 'still' | 'sequence' | 'lambda' | 'preview' | 'versions'
) => {
	if (parsedCli['pixel-format']) {
		Config.Output.setPixelFormat(parsedCli['pixel-format']);
	}

	if (parsedCli['image-format']) {
		Config.Rendering.setImageFormat(parsedCli['image-format']);
	}

	if (parsedCli['browser-executable']) {
		Config.Puppeteer.setBrowserExecutable(parsedCli['browser-executable']);
	}

	if (parsedCli['ffmpeg-executable']) {
		Config.Rendering.setFfmpegExecutable(
			resolve(parsedCli['ffmpeg-executable'])
		);
	}

	if (typeof parsedCli['bundle-cache'] !== 'undefined') {
		Config.Bundling.setCachingEnabled(parsedCli['bundle-cache'] !== 'false');
	}

	if (parsedCli['disable-web-security']) {
		Config.Puppeteer.setChromiumDisableWebSecurity(true);
	}

	if (parsedCli['ignore-certificate-errors']) {
		Config.Puppeteer.setChromiumIgnoreCertificateErrors(true);
	}

	if (parsedCli['disable-headless']) {
		Config.Puppeteer.setChromiumHeadlessMode(false);
	}

	if (parsedCli['skip-n-frames']) {
		Config.Rendering.setSkipNFrames(parsedCli['skip-n-frames']);
	}

	if (parsedCli.gl) {
		Config.Puppeteer.setChromiumOpenGlRenderer(parsedCli.gl);
	}

	if (parsedCli.log) {
		if (!Internals.Logging.isValidLogLevel(parsedCli.log)) {
			Log.error('Invalid `--log` value passed.');
			Log.error(
				`Accepted values: ${Internals.Logging.logLevels
					.map((l) => `'${l}'`)
					.join(', ')}.`
			);
			process.exit(1);
		}

		Internals.Logging.setLogLevel(parsedCli.log as LogLevel);
	}

	if (parsedCli.concurrency) {
		Config.Rendering.setConcurrency(parsedCli.concurrency);
	}

	if (parsedCli.timeout) {
		Config.Puppeteer.setTimeoutInMilliseconds(parsedCli.timeout);
	}

	if (parsedCli.frames) {
		if (type === 'still') {
			Log.error(
				'--frames flag was passed to the `still` command. This flag only works with the `render` command. Did you mean `--frame`? See reference: https://www.remotion.dev/docs/cli/'
			);
			process.exit(1);
		}

		Internals.setFrameRangeFromCli(parsedCli.frames);
	}

	if (parsedCli.frame) {
		if (type === 'sequence') {
			Log.error(
				'--frame flag was passed to the `render` command. This flag only works with the `still` command. Did you mean `--frames`? See reference: https://www.remotion.dev/docs/cli/'
			);
			process.exit(1);
		}

		Internals.setStillFrame(Number(parsedCli.frame));
	}

	if (parsedCli.png) {
		Log.warn(
			'The --png flag has been deprecrated. Use --sequence --image-format=png from now on.'
		);
		Config.Output.setImageSequence(true);
		Config.Rendering.setImageFormat('png');
	}

	if (parsedCli.sequence) {
		Config.Output.setImageSequence(true);
	}

	if (typeof parsedCli.crf !== 'undefined') {
		Config.Output.setCrf(parsedCli.crf);
	}

	if (parsedCli.codec) {
		Config.Output.setCodec(parsedCli.codec);
	}

	if (parsedCli['prores-profile']) {
		Config.Output.setProResProfile(
			String(parsedCli['prores-profile']) as ProResProfile
		);
	}

	if (parsedCli.overwrite) {
		Config.Output.setOverwriteOutput(parsedCli.overwrite);
	}

	if (typeof parsedCli.quality !== 'undefined') {
		Config.Rendering.setQuality(parsedCli.quality);
	}

	if (typeof parsedCli.scale !== 'undefined') {
		Config.Rendering.setScale(parsedCli.scale);
	}

	if (typeof parsedCli.port !== 'undefined') {
		Config.Bundling.setPort(parsedCli.port);
	}
};

export const quietFlagProvided = () => parsedCli.quiet || parsedCli.q;
