import { getProjectDirFromRemote } from "./project";
import to from "await-to-js";
import fs from "fs-extra";
import chalk from "chalk";
import { Config, Project } from "./types/config";
import { ErrorWithHint, ToChildProcessOutput } from "./types/utils";
import { applyPromiseToEntriesWithProgressBar } from "./progress";
import * as utils from "./utils";
import { AssertionError } from "assert";
import tildify from "tildify";

type LogFn = (arg: string | ErrorWithHint) => void;

export async function hasLocalChanges(dir: string): Promise<boolean> {
	const [err, res]: ToChildProcessOutput = await to(
		utils.spawn("git", ["status", "--porcelain"], { cwd: dir, encoding: "utf8" }),
	);
	if (err || !res) {
		throw new ErrorWithHint(chalk`{yellow ${tildify(dir)}} {red failed} to check for local changes ${err?.stderr}`);
	}
	return `${res.stdout}`.trim().length !== 0;
}

async function pull(dir: string, currentBranch: string, log: LogFn) {
	const pcpPromise = utils.spawn("git", ["pull", "--ff-only"], { cwd: dir, encoding: "utf8" });
	const [err, res]: ToChildProcessOutput = await to(pcpPromise);

	if (err || !res) {
		if (`${err?.stderr}`.trim().includes("There is no tracking information for the current branch")) {
			log(chalk`{cyan ${currentBranch}} {red doesn't have a remote origin} in {cyan ${tildify(dir)}}`);
		} else if (`${err?.stderr}`.trim().includes(`Your configuration specifies to merge with the ref`)) {
			log(chalk`{cyan ${currentBranch}} {red no such ref could be fetched} in {cyan ${tildify(dir)}}`);
		} else {
			log(
				chalk`{cyan ${currentBranch}} {red conflicts} with {magenta origin/${currentBranch}} in {cyan ${tildify(dir)}}`,
			);
		}
		return false;
	}

	let localChanges: boolean;
	try {
		localChanges = await hasLocalChanges(dir);
	} catch (error) {
		if (error instanceof ErrorWithHint) {
			log(error);
			return false;
		}
		throw error;
	}

	if (localChanges) {
		log(chalk`{yellow ${currentBranch}} has local changes in {cyan ${dir}}`);
	}

	const msg = `${res.stdout}`.trim();
	if (msg === "Already up to date.") {
		log(chalk`{cyan ${currentBranch}} is up to date with {magenta origin/${currentBranch}} in {cyan ${tildify(dir)}}`);
	} else {
		log(chalk`{cyan ${currentBranch}} pulled changes from {magenta origin/${currentBranch}} in {cyan ${tildify(dir)}}`);
	}
	return true;
}

async function mergeError(dir: string, currentB: string, defaultB: string, log: LogFn) {
	log(chalk`{yellow ${currentB}} merge with {magenta origin/${defaultB}} {red failed} in {cyan ${tildify(dir)}}`);

	const pcpPromise = utils.spawn("git", ["merge", "--abort"], { cwd: dir, encoding: "utf8" });
	const [err] = await to(pcpPromise);
	if (err) {
		log(chalk`{yellow ${currentB}} merge --abort also {red failed} in {cyan ${tildify(dir)}}`);
	}
}

async function merge(dir: string, currentB: string, defaultBranch: string, log: LogFn) {
	const pcpPromise = utils.spawn("git", ["merge", `origin/${defaultBranch}`], { cwd: dir, encoding: "utf8" });
	const [err, res] = await to(pcpPromise);

	if (err || !res) {
		return mergeError(dir, currentB, defaultBranch, log);
	}

	const msg = `${res.stdout}`.trim();
	if (msg === "Already up to date.") {
		log(chalk`{cyan ${currentB}} is up to date with {magenta origin/${defaultBranch}} in {cyan ${tildify(dir)}}`);
	} else {
		log(chalk`{yellow {cyan ${currentB}} was merged with {magenta origin/${defaultBranch}} in {cyan ${tildify(dir)}}}`);
	}
}

async function clone(cwd: string, remote: string, dir: string, log: LogFn) {
	const pcpPromise = utils.spawn("git", ["clone", remote, dir], { cwd, encoding: "utf8" });
	const [err, res]: ToChildProcessOutput = await to(pcpPromise);
	if (err || !res) {
		if (err?.stderr?.includes("Permission denied")) {
			const errorMessage = `Permission denied to clone ${remote}`;
			log(new ErrorWithHint(errorMessage));
			return;
		}
		log(new ErrorWithHint(chalk`{yellow ${remote}} {red failed} in {cyan ${tildify(dir)}} \n${err?.stderr}`));
		return;
	}
	log(chalk`{gray ${remote}} was cloned to {cyan ${tildify(dir)}}`);
}

export async function logHowFarBehindDefaultBranch(
	cwd: string,
	currentBranch: string,
	defaultBranch: string,
	log: LogFn,
) {
	const [err, res]: ToChildProcessOutput = await to(
		utils.spawn("git", ["rev-list", "--count", "--left-right", `${currentBranch}..origin/${defaultBranch}`], {
			cwd,
			encoding: "utf8",
		}),
	);
	if (err || !res) {
		return;
	}
	const splitted = res.stdout.toString().trim().split("\t");
	if (splitted.length !== 2) {
		return;
	}

	if (splitted[1] !== "0") {
		log(
			chalk`{yellow ${currentBranch}} is {red ${splitted[1]}} commits behind {cyan ${defaultBranch}} in {cyan ${tildify(
				cwd,
			)}}`,
		);
	}
	if (splitted[0] !== "0") {
		log(
			chalk`{yellow ${currentBranch}} is {green ${
				splitted[0]
			}} commits ahead of {cyan ${defaultBranch}} in {cyan ${tildify(cwd)}}`,
		);
	}
}

export async function gitops(
	cwd: string,
	projectObj: Project,
	autoMerge: boolean,
): Promise<(string | ErrorWithHint)[]> {
	const logs: (string | ErrorWithHint)[] = [];
	const log = (arg: string | ErrorWithHint) => {
		logs.push(arg);
	};
	const remote = projectObj["remote"];
	const defaultBranch = projectObj["default_branch"];
	const dir = getProjectDirFromRemote(cwd, remote);

	if (!(await fs.pathExists(`${dir}`))) {
		await clone(cwd, remote, dir, log);
		return logs;
	}

	const pcpPromise = utils.spawn("git", ["branch", "--show-current"], { cwd: dir, encoding: "utf8" });
	const [err, res]: ToChildProcessOutput = await to(pcpPromise);

	if (err || !res) {
		log(new ErrorWithHint(chalk`{yellow ${remote}} {red failed} in {cyan ${tildify(dir)}} ${err}`));
		return logs;
	}

	const currentBranch = `${res.stdout}`.trim();

	if (currentBranch === defaultBranch) {
		await pull(dir, currentBranch, log);
	} else {
		if (await pull(dir, currentBranch, log)) {
			if (autoMerge) {
				await merge(dir, currentBranch, defaultBranch, log);
			}
		}
	}
	await logHowFarBehindDefaultBranch(dir, currentBranch, defaultBranch, log);
	return logs;
}

export function handleGitopsResults(projectNames: string[], logs: (string | ErrorWithHint)[][]) {
	let errorCount = 0;
	for (const [i, projectName] of projectNames.entries()) {
		const isError = logs[i].filter((log) => log instanceof ErrorWithHint).length > 0;

		if (!isError) {
			console.log(chalk`┌─ {green {bold ${projectName}}}`);
		} else {
			errorCount++;
			console.log(chalk`┌─ {red {bold ${projectName}}}`);
		}

		for (const [j, log] of logs[i].entries()) {
			let formattedLog = "";
			if (log instanceof ErrorWithHint) {
				formattedLog = chalk`{red ${log.hint}}`;
			} else {
				formattedLog = log;
			}

			console.log(`${j === logs[i].length - 1 ? "└" : "├"}─── ${formattedLog}`);
		}
	}

	if (errorCount > 0) {
		throw new AssertionError({ message: "At least one git operation failed" });
	}
}

export async function fromConfig(cnf: Config, autoMerge: boolean) {
	utils.printHeader("Git Operations");
	const fn = (arg: Project) => gitops(cnf.cwd, arg, autoMerge);
	const result = await applyPromiseToEntriesWithProgressBar("git-operations", Object.entries(cnf.projects), fn);
	console.log();
	handleGitopsResults(Object.keys(cnf.projects), result);
}
