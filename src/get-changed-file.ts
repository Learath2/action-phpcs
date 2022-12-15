import { spawn } from 'child_process';
import { createInterface } from 'readline';
import { existsSync } from 'fs';

import * as core from '@actions/core';
import * as github from '@actions/github';
import * as Webhooks from '@octokit/webhooks-types';
import picomatch from 'picomatch';

interface ChangedFiles {
  added: string[];
  modified: string[];
}

export async function getChangedFiles(): Promise<ChangedFiles> {
  const pattern = core.getInput('files', {
    required: false,
  });
  const globs = pattern.length ? pattern.split(',') : ['**.php'];
  const isMatch = picomatch(globs);
  core.info(`Filter patterns: ${globs.join()}`);

  let base = '';
  switch (github.context.eventName) {
    case 'pull_request':
      base = (github.context.payload as Webhooks.PullRequestEvent).pull_request
        .base.sha;
      break;
    case 'push':
      {
        const payload = github.context.payload as Webhooks.PushEvent;
        if (payload.forced) {
          //TODO: Implement this with octokit
          core.warning(`Linting for forced pushes isn't implemented yet`);
          return {
            added: [],
            modified: [],
          };
        }

        base = payload.before;
      }
      break;
    default:
      core.error(`Unknown event type ${github.context.eventName}`);
      return {
        added: [],
        modified: [],
      };
  }

  core.debug(`Base SHA: ${base}`);

  /*
    getting them from Git
    git diff-tree --no-commit-id --name-status --diff-filter=d -r ${{ github.event.pull_request.base.sha }}..${{ github.event.after }}
  */
  try {
    const git = spawn(
      'git',
      [
        '--no-pager',
        'diff-tree',
        '--no-commit-id',
        '--name-status',
        '--diff-filter=d', // we don't need deleted files
        '-r',
        `${base}..`,
      ],
      {
        windowsHide: true,
        timeout: 5000,
      }
    ).on('exit', code => {
      if (code) {
        core.debug(`git: ${code}`);
        if (code != 0) {
          core.error(`git exited with ${code}`);
        }
      }
    });

    git.stderr.on('data', (d: string) => {
      core.error(`git stderr: ${d}`);
    });

    const readline = createInterface({
      input: git.stdout,
    });
    const result: ChangedFiles = {
      added: [],
      modified: [],
    };
    for await (const line of readline) {
      core.debug(`${line}`);
      const parsed = /^(?<status>[ACMR])[\s\t]+(?<file>\S+)$/.exec(line);
      if (parsed?.groups) {
        const { status, file } = parsed.groups;
        // ensure file exists
        if (isMatch(file) && existsSync(file)) {
          switch (status) {
            case 'A':
            case 'C':
            case 'R':
              result.added.push(file);
              break;

            case 'M':
              result.modified.push(file);
          }
        }
      }
    }
    return result;
  } catch (err) {
    core.error((err as Error).message);
    return {
      added: [],
      modified: [],
    };
  }
}
