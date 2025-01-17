import type { ChangeDescription } from "../change/types.js";
import { getDependentsGraph } from "../dependency-graph/index.js";
import type { ChronusWorkspace } from "../workspace/types.js";
import { applyDependents } from "./determine-dependents.js";
import { incrementVersion } from "./increment-version.js";
import type { InternalReleaseAction } from "./types.internal.js";
import type { ReleaseAction, ReleasePlan } from "./types.js";

export interface ApplyChangesetsOptions {
  ignorePolicies?: boolean;
}

export function assembleReleasePlan(
  changes: ChangeDescription[],
  workspace: ChronusWorkspace,
  options?: ApplyChangesetsOptions,
): ReleasePlan {
  const packagesByName = new Map(workspace.allPackages.map((pkg) => [pkg.name, pkg]));
  const requested = reduceChanges(changes, workspace);

  const dependentsGraph = getDependentsGraph(workspace.allPackages);
  const internalActions = new Map<string, InternalReleaseAction>();
  if (workspace.config.versionPolicies && !options?.ignorePolicies) {
    for (const policy of workspace.config.versionPolicies) {
      if (policy.type === "lockstep") {
        for (const pkgName of policy.packages) {
          const pkg = packagesByName.get(pkgName);
          if (!pkg) throw new Error(`Could not find package ${pkgName}`);
          internalActions.set(pkgName, {
            packageName: pkgName,
            type: policy.step,
            oldVersion: pkg.version,
            policy: policy,
          });
        }
      }
    }
  }

  for (const request of requested.values()) {
    const existing = internalActions.get(request.packageName);
    if (!existing) {
      internalActions.set(request.packageName, request);
    }
  }

  // The map passed in to determineDependents will be mutated
  applyDependents({
    actions: internalActions,
    workspace,
    dependentsGraph,
  });

  const actions = [...internalActions.values()].map((incompleteRelease): ReleaseAction => {
    return {
      ...incompleteRelease,
      newVersion: getNewVersion(incompleteRelease),
      changes: changes.filter((change) => change.packages.some((pkgName) => pkgName === incompleteRelease.packageName)),
    };
  });

  return {
    changes,
    actions,
  };
}

function reduceChanges(changes: ChangeDescription[], workspace: ChronusWorkspace): Map<string, InternalReleaseAction> {
  const releases: Map<string, InternalReleaseAction> = new Map();

  changes.forEach((change) => {
    const type = change.changeKind.versionType;
    change.packages
      // Filter out ignored packages because they should not trigger a release
      // If their dependencies need updates, they will be added to releases by `determineDependents()` with release type `none`
      .filter((name) => !workspace.getPackage(name).ignored)
      .forEach((name) => {
        let release: InternalReleaseAction | undefined = releases.get(name);
        const pkg = workspace.allPackages.find((x) => x.name === name);
        if (!pkg) {
          throw new Error(
            `"${change}" changeset mentions a release for a package "${name}" but such a package could not be found.`,
          );
        }
        if (!release) {
          release = {
            packageName: name,
            type,
            oldVersion: pkg.version,
            policy: { name: "<auto>", type: "independent", packages: [name] },
          };
        } else {
          if (
            type === "major" ||
            ((release.type === "patch" || release.type === "none") && (type === "minor" || type === "patch"))
          ) {
            release.type = type;
          }
        }

        releases.set(name, release);
      });
  });

  return releases;
}

function getNewVersion(release: InternalReleaseAction): string {
  if (release.type === "none") {
    return release.oldVersion;
  }

  return incrementVersion(release);
}
