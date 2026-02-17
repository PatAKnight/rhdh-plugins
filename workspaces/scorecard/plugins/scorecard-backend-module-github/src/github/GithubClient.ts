/*
 * Copyright Red Hat, Inc.
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 *     http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an "AS IS" BASIS,
 * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 * See the License for the specific language governing permissions and
 * limitations under the License.
 */

import type { Config } from '@backstage/config';
import {
  DefaultGithubCredentialsProvider,
  ScmIntegrations,
} from '@backstage/integration';
import { GithubRepository } from './types';

export class GithubClient {
  private readonly integrations: ScmIntegrations;

  constructor(config: Config) {
    this.integrations = ScmIntegrations.fromConfig(config);
  }

  private async getOctokitClient(url: string): Promise<typeof graphql> {
    const githubIntegration = this.integrations.github.byUrl(url);
    if (!githubIntegration) {
      throw new Error(`Missing GitHub integration for '${url}'`);
    }

    const credentialsProvider =
      DefaultGithubCredentialsProvider.fromIntegrations(this.integrations);

    const { headers } = await credentialsProvider.getCredentials({
      url,
    });

    const { graphql } = await import('@octokit/graphql');
    return graphql.defaults({
      headers,
      baseUrl: githubIntegration.config.apiBaseUrl,
    });
  }

  async getOpenPullRequestsCount(
    url: string,
    repository: GithubRepository,
  ): Promise<number> {
    const octokit = await this.getOctokitClient(url);

    const query = `
      query getOpenPRsCount($owner: String!, $repo: String!) {
        repository(owner: $owner, name: $repo) {
          pullRequests(states: OPEN) {
            totalCount
          }
        }
      }
    `;

    const response = await octokit<{
      repository: {
        pullRequests: {
          totalCount: number;
        };
      };
    }>(query, {
      owner: repository.owner,
      repo: repository.repo,
    });

    return response.repository.pullRequests.totalCount;
  }

  /**
   * Check if multiple files exist in a repository using a single GraphQL call.
   * Uses GraphQL aliases to batch multiple object lookups.
   *
   * @param url - The GitHub URL for authentication
   * @param repository - The repository info (owner/repo)
   * @param files - Map of alias to file path (e.g., { "codeowners": "CODEOWNERS" })
   * @returns Map of alias to boolean (exists or not)
   */
  async checkFilesExist(
    url: string,
    repository: GithubRepository,
    files: Map<string, string>,
  ): Promise<Map<string, boolean>> {
    const octokit = await this.getOctokitClient(url);

    // Build dynamic query with aliases
    const fileChecks = Array.from(files.entries())
      .map(
        ([alias, path]) =>
          `${alias}: object(expression: "HEAD:${path}") { id }`,
      )
      .join('\n');

    const query = `
    query checkFilesExist($owner: String!, $repo: String!) {
      repository(owner: $owner, name: $repo) {
        ${fileChecks}
      }
    }
  `;

    const response = await octokit<{
      repository: Record<string, { id: string } | null>;
    }>(query, {
      owner: repository.owner,
      repo: repository.repo,
    });

    const results = new Map<string, boolean>();
    for (const [alias] of files) {
      results.set(alias, response.repository[alias] !== null);
    }
    return results;
  }
}
