import {getCompositions} from '@remotion/renderer';
import path from 'path';
import {getCliOptions} from './get-cli-options';
import {loadConfig} from './get-config-file-name';
import {Log} from './log';
import {parsedCli} from './parse-command-line';
import {bundleOnCli} from './setup-cache';

const max = (arr: number[]) => {
	if (arr.length === 0) {
		throw new Error('Array of 0 length');
	}

	let biggest = arr[0];
	for (let i = 0; i < arr.length; i++) {
		const elem = arr[i];
		if (elem > biggest) {
			biggest = elem;
		}
	}

	return biggest;
};

export const listCompositionsCommand = async () => {
	const file = parsedCli._[1];

	if (!file) {
		Log.error(
			'The compositions command requires you to specify a root file. For example'
		);
		Log.error('  npx remotion compositions src/index.tsx');
		Log.error(
			'See https://www.remotion.dev/docs/register-root for more information.'
		);
		process.exit(1);
	}

	const fullPath = path.join(process.cwd(), file);

	loadConfig();

	const {
		browserExecutable,
		ffmpegExecutable,
		chromiumOptions,
		envVariables,
		inputProps,
		puppeteerTimeout,
		port,
	} = await getCliOptions({isLambda: false, type: 'get-compositions'});

	const bundled = await bundleOnCli(fullPath, ['bundling']);

	const compositions = await getCompositions(bundled, {
		browserExecutable,
		ffmpegExecutable,
		chromiumOptions,
		envVariables,
		inputProps,
		timeoutInMilliseconds: puppeteerTimeout,
		port,
	});
	Log.info();
	Log.info('The following compositions are available:');
	Log.info();

	const firstColumnLength = max(compositions.map(({id}) => id.length)) + 4;
	const secondColumnLength = 8;
	const thirdColumnLength = 15;

	Log.info(
		`${'Composition'.padEnd(firstColumnLength, ' ')}${'FPS'.padEnd(
			secondColumnLength
		)}${'Dimensions'.padEnd(thirdColumnLength, ' ')}Duration`
	);
	Log.info(
		compositions
			.map((comp) => {
				const isStill = comp.durationInFrames === 1;
				const dimensions = `${comp.width}x${comp.height}`;
				const fps = isStill ? '' : comp.fps.toString();
				const durationInSeconds = (comp.durationInFrames / comp.fps).toFixed(2);
				const formattedDuration = isStill
					? 'Still'
					: `${comp.durationInFrames} (${durationInSeconds} sec)`;
				return [
					comp.id.padEnd(firstColumnLength, ' '),
					fps.padEnd(secondColumnLength, ' '),
					dimensions.padEnd(thirdColumnLength, ' '),
					formattedDuration,
				].join('');
			})
			.join('\n')
	);
};
