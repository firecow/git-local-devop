import { getProjectDirFromRemote } from "../project";
import { Config } from "../types/config";
import { GroupKey } from "../types/utils";
import { Task } from "./task";

type ProjectAction = {
	project: string;
	action: string;
};

type GroupKeyWithDependencies = GroupKey & { needs: GroupKey[] };

/**
 * Given an input of
 * - Actions
 * - Groups
 * - Projects
 *
 * Generate the task list needed to run.
 */
class TaskPlanner {
	constructor(private config: Config) {}

	public planStringInput(actionsStr: string, groupsStr: string, projectsStr: string) {
		let actions = actionsStr.split("+");
		let groups = groupsStr.split("+");
		let projects = projectsStr.split("+");

		// rewrite "all" to "*"
		actions = actions.map((action) => {
			return action == "all" ? "*" : action;
		});
		groups = groups.map((group) => {
			return group == "all" ? "*" : group;
		});
		projects = projects.map((project) => {
			return project == "all" ? "*" : project;
		});

		return this.plan(actions, groups, projects);
	}

	public plan(actions: string[], groups: string[], projects: string[]): Task[] {
		// First find all actions explicitly.
		const keySets = this.findKeySets(actions, groups, projects);

		// For each key set, create a task.
		return keySets.map((keySet) => {
			const project = this.config.projects[keySet.project];
			const action = project.actions[keySet.action];
			const needs = this.config.needs ? action.needs.map((need: string) => ({ ...keySet, action: need })) : [];
			const cwd = getProjectDirFromRemote(this.config.cwd, project.remote);

			return new Task(keySet, { cwd, cmd: action.groups[keySet.group], priority: action.priority ?? 0 }, needs);
		});
	}

	findKeySets(actionsStr: string[], groupsStr: string[], projectsStr: string[]): GroupKey[] {
		const projects = this.findProjects(projectsStr);
		const actions = this.findActions(projects, actionsStr);
		let keySets = this.findGroups(actions, groupsStr);

		if (this.config.needs) {
			// Resolve dependencies between projects of same action and group.
			keySets = this.addProjectDependencies(keySets);
		}
		// Resolve any unrunnable dependencies
		keySets = this.removeUnrunnable(keySets);

		// Remove duplicates
		keySets = [...new Set(keySets)];

		return keySets;
	}

	/**
	 * Remove keySets with group "!", and replace involved dependencies.
	 * @param keySets
	 */
	removeUnrunnable(keySets: GroupKeyWithDependencies[]): GroupKeyWithDependencies[] {
		let keySetsCopy = [...keySets];
		for (const keySet of keySets) {
			if (keySet.group == "!") {
				keySetsCopy = keySetsCopy.filter((keySetFilter) => keySet != keySetFilter);
				// find all keySets that depend on this keySet
				const dependentKeySets = keySetsCopy.filter((keySetFilter) => keySetFilter.needs.includes(keySet));
				// replace the dependency with the dependencies of the unrunnable keyset.
				for (const dependentKeySet of dependentKeySets) {
					dependentKeySet.needs = [
						...dependentKeySet.needs.filter((keySetFilter) => keySetFilter != keySet),
						...keySet.needs,
					];
				}
			}
		}

		return keySetsCopy;
	}

	/**
	 * This function should handle the "needs" property of the action.
	 * It should rewrite the "needs" string array to an array of GroupKey, and also add the dependencies
	 */
	addProjectDependencies(keySets: GroupKeyWithDependencies[]): GroupKeyWithDependencies[] {
		// go through each key set, and verify that all dependencies are met.

		const foundKeySets = [...keySets];

		for (const keySet of keySets) {
			foundKeySets.push(...this.addProjectDependenciesHelper(keySet, foundKeySets));
		}

		return foundKeySets;
	}

	addProjectDependenciesHelper(
		keySet: GroupKeyWithDependencies,
		keySets: GroupKeyWithDependencies[],
	): GroupKeyWithDependencies[] {
		const project = this.config.projects[keySet.project];
		const action = project.actions[keySet.action];
		const needs = this.findNeedGroupKeys(keySet, action.needs);

		return [
			...needs,
			...needs.reduce((carry, need) => {
				return [...carry, ...this.addProjectDependenciesHelper(need, keySets)];
			}, [] as GroupKeyWithDependencies[]),
		];
	}

	findNeedGroupKeys(keySet: GroupKeyWithDependencies, needsStr: string[]): GroupKeyWithDependencies[] {
		return needsStr.map((needStr) => {
			const project = this.config.projects[needStr];
			const action = project.actions[keySet.action];
			if (action.groups[keySet.group]) {
				return { ...keySet, project: needStr };
			}
			if (action.groups["*"]) {
				return { ...keySet, project: needStr, group: "*" };
			}
			// not able to be solved.. mark it as so
			return { ...keySet, project: needStr, group: "!" };
		});
	}

	findProjects(projectsStr: string[]): string[] {
		if (projectsStr.includes("*")) {
			return Object.keys(this.config.projects);
		}

		return Object.keys(this.config.projects).filter((projectName) => projectsStr.includes(projectName));
	}

	findActions(projects: string[], actionsStr: string[]): ProjectAction[] {
		// Collect all matching actions from all projects
		return projects.reduce((carry, projectName) => {
			const project = this.config.projects[projectName];
			const actions = Object.keys(project.actions)
				.filter((actionName) => actionsStr.includes(actionName) || actionsStr.includes("*"))
				.map((actionName) => ({ project: projectName, action: actionName }));
			return [...carry, ...actions];
		}, [] as ProjectAction[]);
	}

	findGroups(projectActions: ProjectAction[], groupsStr: string[]): GroupKeyWithDependencies[] {
		return projectActions.reduce((carry, projectAction) => {
			const action = this.config.projects[projectAction.project].actions[projectAction.action];
			const groups = Object.keys(action.groups)
				.filter((groupName) => groupsStr.includes(groupName) || groupsStr.includes("*"))
				.map((groupName) => ({ ...projectAction, group: groupName, needs: [] }));
			return [...carry, ...groups];
		}, [] as GroupKeyWithDependencies[]);
	}
}

export { TaskPlanner };
