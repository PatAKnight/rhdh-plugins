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
import { getEntitySourceLocation, type Entity } from '@backstage/catalog-model';
import { CATALOG_FILTER_EXISTS } from '@backstage/catalog-client';
import {
  Metric,
  ThresholdConfig,
} from '@red-hat-developer-hub/backstage-plugin-scorecard-common';
import { MetricProvider } from '@red-hat-developer-hub/backstage-plugin-scorecard-node';
import { GithubClient } from '../github/GithubClient';
import { getRepositoryInformationFromEntity } from '../github/utils';

export interface GithubFileConfig {
  /** Metric identifier (used in metric ID) */
  id: string;
  /** File path to check */
  path: string;
}

const DEFAULT_BOOLEAN_THRESHOLDS: ThresholdConfig = {
  rules: [
    { key: 'success', expression: '==true' },
    { key: 'error', expression: '==false' },
  ],
};

export class GithubFilesProvider implements MetricProvider<'boolean'> {
  private readonly githubClient: GithubClient;
  private readonly thresholds: ThresholdConfig;
  private readonly fileConfigs: GithubFileConfig[];

  private constructor(
    config: Config,
    fileConfigs: GithubFileConfig[],
    thresholds?: ThresholdConfig,
  ) {
    this.githubClient = new GithubClient(config);
    this.fileConfigs = fileConfigs;
    this.thresholds = thresholds ?? DEFAULT_BOOLEAN_THRESHOLDS;
  }

  getProviderDatasourceId(): string {
    return 'github';
  }

  // Base provider ID (required by interface)
  getProviderId(): string {
    return 'github.files';
  }

  // All metric IDs this provider handles
  getMetricIds(): string[] {
    return this.fileConfigs.map(f => `github.files.${f.id}`);
  }

  getMetricType(): 'boolean' {
    return 'boolean';
  }

  // Single metric (for backward compat)
  getMetric(): Metric<'boolean'> {
    return this.getMetrics()[0];
  }

  // All metrics this provider exposes
  getMetrics(): Metric<'boolean'>[] {
    return this.fileConfigs.map(f => ({
      id: `github.files.${f.id}`,
      title: `GitHub File: ${f.path}`,
      description: `Checks if ${f.path} exists in the repository.`,
      type: 'boolean' as const,
      history: true,
    }));
  }

  getMetricThresholds(): ThresholdConfig {
    return this.thresholds;
  }

  getCatalogFilter(): Record<string, string | symbol | (string | symbol)[]> {
    return {
      'metadata.annotations.github.com/project-slug': CATALOG_FILTER_EXISTS,
    };
  }

  // Legacy single calculation (shouldn't be called for batch providers)
  async calculateMetric(entity: Entity): Promise<boolean> {
    const results = await this.calculateMetrics(entity);
    const firstId = this.getMetricIds()[0];
    return results.get(firstId) ?? false;
  }

  // Batch calculation - single API call for all files
  async calculateMetrics(entity: Entity): Promise<Map<string, boolean>> {
    const repository = getRepositoryInformationFromEntity(entity);
    const { target } = getEntitySourceLocation(entity);

    // Build map of metricId -> filePath
    const filePathMap = new Map<string, string>();
    for (const f of this.fileConfigs) {
      filePathMap.set(`github.files.${f.id}`, f.path);
    }

    // Single API call to check all files
    const existsMap = await this.githubClient.checkFilesExist(
      target,
      repository,
      filePathMap,
    );

    return existsMap;
  }

  static fromConfig(config: Config): GithubFilesProvider | undefined {
    const filesConfig = config.getOptionalConfigArray(
      'scorecard.plugins.github.files',
    );

    if (!filesConfig || filesConfig.length === 0) {
      return undefined;
    }

    const fileConfigs: GithubFileConfig[] = filesConfig.map(fileConfig => {
      const keys = fileConfig.keys();
      if (keys.length !== 1) {
        throw new Error(
          'Each file config entry must have exactly one key-value pair',
        );
      }
      const id = keys[0];
      const path = fileConfig.getString(id);
      return { id, path };
    });

    return new GithubFilesProvider(config, fileConfigs);
  }
}
