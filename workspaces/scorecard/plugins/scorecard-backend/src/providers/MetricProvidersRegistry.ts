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

import { ConflictError, NotFoundError } from '@backstage/errors';
import {
  Metric,
  MetricValue,
} from '@red-hat-developer-hub/backstage-plugin-scorecard-common';
import type { Entity } from '@backstage/catalog-model';
import { MetricProvider } from '@red-hat-developer-hub/backstage-plugin-scorecard-node';

/**
 * Registry of all registered metric providers.
 */
export class MetricProvidersRegistry {
  private readonly metricProviders = new Map<string, MetricProvider>();
  private readonly datasourceIndex = new Map<string, Set<string>>();

  register(metricProvider: MetricProvider): void {
    const providerDatasource = metricProvider.getProviderDatasourceId();
    const metricType = metricProvider.getMetricType();

    // Support both single and batch providers
    const metricIds = metricProvider.getMetricIds?.() ?? [
      metricProvider.getProviderId(),
    ];
    const metrics = metricProvider.getMetrics?.() ?? [
      metricProvider.getMetric(),
    ];

    // Validate: Each metric ID must have a corresponding metric definition
    for (const metricId of metricIds) {
      const metric = metrics.find(m => m.id === metricId);
      if (!metric) {
        throw new Error(
          `Invalid metric provider: metric ID '${metricId}' returned by getMetricIds() ` +
            `does not have a corresponding metric in getMetrics()`,
        );
      }

      // Validate: Metric type must match
      if (metricType !== metric.type) {
        throw new Error(
          `Invalid metric provider with ID ${metricId}, getMetricType() must match ` +
            `getMetric().type. Expected '${metricType}', but got '${metric.type}'`,
        );
      }

      // Validate: Provider ID format (datasource.metric_name)
      const expectedPrefix = `${providerDatasource}.`;
      if (!metricId.startsWith(expectedPrefix) || metricId === expectedPrefix) {
        throw new Error(
          `Invalid metric provider with ID ${metricId}, must have format ` +
            `'${providerDatasource}.<metric_name>' where metric name is not empty`,
        );
      }

      // Validate: No duplicate IDs
      if (this.metricProviders.has(metricId)) {
        throw new ConflictError(
          `Metric provider with ID '${metricId}' has already been registered`,
        );
      }

      // Register: Each metric ID maps to the same provider instance
      this.metricProviders.set(metricId, metricProvider);

      // Index by datasource
      let datasourceProviders = this.datasourceIndex.get(providerDatasource);
      if (!datasourceProviders) {
        datasourceProviders = new Set();
        this.datasourceIndex.set(providerDatasource, datasourceProviders);
      }
      datasourceProviders.add(metricId);
    }
  }

  getProvider(providerId: string): MetricProvider {
    const metricProvider = this.metricProviders.get(providerId);
    if (!metricProvider) {
      throw new NotFoundError(
        `Metric provider with ID '${providerId}' is not registered.`,
      );
    }
    return metricProvider;
  }

  getMetric(providerId: string): Metric {
    const provider = this.getProvider(providerId);

    // For batch providers, find the specific metric by ID
    if (provider.getMetrics) {
      const metrics = provider.getMetrics();
      const metric = metrics.find(m => m.id === providerId);
      if (metric) {
        return metric;
      }
    }

    // Fall back to single metric
    return provider.getMetric();
  }

  async calculateMetric(
    providerId: string,
    entity: Entity,
  ): Promise<MetricValue> {
    return this.getProvider(providerId).calculateMetric(entity);
  }

  async calculateMetrics(
    providerIds: string[],
    entity: Entity,
  ): Promise<{ providerId: string; value?: MetricValue; error?: Error }[]> {
    const results = await Promise.allSettled(
      providerIds.map(providerId => this.calculateMetric(providerId, entity)),
    );

    return results.map((result, index) => {
      const providerId = providerIds[index];
      if (result.status === 'fulfilled') {
        return { providerId, value: result.value };
      }
      return { providerId, error: result.reason as Error };
    });
  }

  listProviders(): MetricProvider[] {
    return Array.from(this.metricProviders.values());
  }

  listMetrics(providerIds?: string[]): Metric[] {
    if (providerIds && providerIds.length !== 0) {
      return providerIds
        .map(providerId => {
          const provider = this.metricProviders.get(providerId);
          if (!provider) return undefined;

          // Try batch provider first
          if (provider.getMetrics) {
            const metrics = provider.getMetrics();
            return metrics.find(m => m.id === providerId);
          }

          // Fall back to single metric
          return provider.getMetric();
        })
        .filter((m): m is Metric => m !== undefined);
    }

    // List all metrics from all providers (deduplicate batch providers)
    const seen = new Set<MetricProvider>();
    const allMetrics: Metric[] = [];

    for (const provider of this.metricProviders.values()) {
      if (seen.has(provider)) continue;
      seen.add(provider);

      if (provider.getMetrics) {
        allMetrics.push(...provider.getMetrics());
      } else {
        allMetrics.push(provider.getMetric());
      }
    }

    return allMetrics;
  }

  listMetricsByDatasource(datasourceId: string): Metric[] {
    const providerIdsOfDatasource = this.datasourceIndex.get(datasourceId);

    if (!providerIdsOfDatasource) {
      return [];
    }

    // Deduplicate providers since batch providers have multiple IDs
    const seen = new Set<MetricProvider>();
    const allMetrics: Metric[] = [];

    for (const providerId of providerIdsOfDatasource) {
      const provider = this.metricProviders.get(providerId);
      if (!provider || seen.has(provider)) continue;
      seen.add(provider);

      if (provider.getMetrics) {
        allMetrics.push(...provider.getMetrics());
      } else {
        allMetrics.push(provider.getMetric());
      }
    }

    return allMetrics;
  }
}
