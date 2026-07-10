import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import axios, { AxiosRequestConfig, AxiosResponse } from 'axios';
import * as aws4 from 'aws4';
import { URL } from 'url';
import { AuthService } from '../auth/auth.service';
import { normalizeDateToUTC } from '../utils/date.util';
import { maskSecret } from '../utils/mask-secret.util';
import * as zlib from 'zlib';
import { promisify } from 'util';
import Bottleneck from 'bottleneck';
import { CACHE_MANAGER } from '@nestjs/cache-manager';
import type { Cache } from 'cache-manager';
import { Inject } from '@nestjs/common';

export enum QuotaGroup {
  CREATE_REPORT = 'CREATE_REPORT',
  GET_REPORT = 'GET_REPORT',
  GET_REPORT_DOCUMENT = 'GET_REPORT_DOCUMENT',
  DOWNLOAD_REPORT = 'DOWNLOAD_REPORT',
  GENERIC = 'GENERIC',
}

export interface QuotaStatus {
  group: QuotaGroup;
  status: 'OK' | 'COOLDOWN' | 'UNKNOWN';
  lastRateLimitHeader: string | null;
  calculatedMinDelayMs: number;
  lastSuccessAt: string | null;
  last429At: string | null;
  consecutive429Count: number;
  cooldownUntil: string | null;
  nextAllowedAt: string | null;
}

const gunzip = promisify(zlib.gunzip);

export class RateLimitError extends Error {
  readonly statusCode = 429;
  readonly retryAfter: number | null;

  constructor(endpoint: string, retryAfter: number | null = null) {
    const hint = retryAfter
      ? ` Amazon says retry after ${retryAfter}s.`
      : ' Wait for Amazon SP-API quota to refill before retrying.';
    super(`Amazon SP-API rate limit (429) hit on ${endpoint}.${hint}`);
    this.name = 'RateLimitError';
    this.retryAfter = retryAfter;
  }
}

@Injectable()
export class AmazonApiService {
  private readonly logger = new Logger(AmazonApiService.name);
  private nextAllowedRequestTime: number = 0;

  // SP-API Rate Limiters (legacy-compatible: 1 request per 65s)
  // We use separate limiters for creation and document metadata as they have distinct quotas,
  // but we enforce a strict 65s gap to be safe.
  private readonly createReportLimiter = new Bottleneck({
    maxConcurrent: 1,
    minTime: 65000,
  });

  private readonly getReportLimiter = new Bottleneck({
    maxConcurrent: 1,
    minTime: 2000, // getReport (polling) has a higher limit, but 2s is safe
  });

  private readonly documentLimiter = new Bottleneck({
    maxConcurrent: 1,
    minTime: 65000,
  });

  private readonly QUOTA_BASE_KEY = 'amazon_quota_';

  constructor(
    private readonly authService: AuthService,
    private readonly configService: ConfigService,
    @Inject(CACHE_MANAGER) private cacheManager: Cache,
  ) {}

  normalizeDate(date: string | Date, type: 'start' | 'end'): string {
    return normalizeDateToUTC(date, type);
  }

  private delay(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }

  private getTimeoutMs(): number {
    const seconds = Number(this.configService.get<string>('AMAZON_API_TIMEOUT_SECONDS') || '60');
    return Number.isFinite(seconds) && seconds > 0 ? Math.floor(seconds * 1000) : 60_000;
  }

  private getMaxRetries(isReportDocumentEndpoint = false): number {
    const configured = this.configService.get<string>('AMAZON_API_MAX_RETRIES');
    const fallback = isReportDocumentEndpoint ? 8 : 5;
    const retries = configured === undefined ? fallback : Number(configured);
    return Number.isInteger(retries) && retries >= 0 ? Math.min(retries, 20) : fallback;
  }

  private isTransientFailure(error: any): boolean {
    const status = error?.response?.status;
    if ([429, 500, 502, 503, 504].includes(status)) return true;
    return !status && ['ECONNRESET', 'ETIMEDOUT', 'ECONNABORTED', 'EPIPE'].includes(error?.code);
  }

  private getRequestId(error: any): string | null {
    const headers = error?.response?.headers;
    return headers?.['x-amzn-requestid'] ?? headers?.['x-amz-request-id'] ?? null;
  }

  private safeErrorDetails(error: any): string {
    const responseError = error?.response?.data?.errors?.[0];
    const details = {
      code: responseError?.code ?? error?.code ?? null,
      message: error?.message ?? 'Amazon request failed',
      requestId: this.getRequestId(error),
    };
    return maskSecret(JSON.stringify(details)).slice(0, 1000);
  }

  private exponentialBackoffMs(attempt: number): number {
    return 1000 * Math.pow(2, attempt) + Math.floor(Math.random() * 500);
  }

  private signRequest(method: string, url: URL, accessToken: string, data?: any): AxiosRequestConfig {
    const useSigV4 = this.configService.get<string>('USE_SIGV4') !== 'false';
    const credentials = this.authService.getAwsCredentials();

    const headers: Record<string, string> = {
      'x-amz-access-token': accessToken,
      'Content-Type': 'application/json',
      Accept: 'application/json',
    };

    if (!useSigV4) {
      this.logger.debug(`[Auth] Using LWA-only authentication (SigV4 disabled).`);
      return {
        method,
        url: url.toString(),
        headers,
        data,
        timeout: this.getTimeoutMs(),
      };
    }

    if (!credentials.accessKeyId || !credentials.secretAccessKey) {
      throw new Error('Missing SP_API_AWS_ACCESS_KEY_ID or SP_API_AWS_SECRET_ACCESS_KEY while SigV4 is enabled.');
    }

    const signOptions: aws4.Request = {
      host: url.host,
      path: url.pathname + url.search,
      method: method,
      headers,
      region: credentials.region,
      service: 'execute-api',
    };

    if (data) {
      signOptions.body = JSON.stringify(data);
    }

    aws4.sign(signOptions, {
      accessKeyId: credentials.accessKeyId,
      secretAccessKey: credentials.secretAccessKey,
    });

    return {
      method: signOptions.method,
      url: `https://${signOptions.host}${signOptions.path}`,
      headers: signOptions.headers as any,
      data: data,
      timeout: this.getTimeoutMs(),
    };
  }

  private async updateQuotaStatus(endpoint: string, response?: AxiosResponse, error?: any) {
    const group = this.getQuotaGroup(endpoint);
    const key = `${this.QUOTA_BASE_KEY}${group}`;
    const now = new Date();

    const currentRaw = await this.cacheManager.get<QuotaStatus>(key);
    const current: QuotaStatus = currentRaw || {
      group,
      status: 'OK',
      lastRateLimitHeader: null,
      calculatedMinDelayMs: 0,
      lastSuccessAt: null,
      last429At: null,
      consecutive429Count: 0,
      cooldownUntil: null,
      nextAllowedAt: null,
    };

    const headers = response?.headers || error?.response?.headers;
    const status = response?.status || error?.response?.status;

    // 1. Success Path
    if (status && status >= 200 && status < 300) {
      current.lastSuccessAt = now.toISOString();
      current.consecutive429Count = 0;
      current.status = current.cooldownUntil && new Date(current.cooldownUntil) > now ? 'COOLDOWN' : 'OK';

      const limitHeader = headers?.['x-amzn-ratelimit-limit'];
      if (limitHeader) {
        current.lastRateLimitHeader = limitHeader;
        const limit = parseFloat(limitHeader);
        if (!isNaN(limit) && limit > 0) {
          current.calculatedMinDelayMs = Math.ceil(1000 / limit);
          current.nextAllowedAt = new Date(Date.now() + current.calculatedMinDelayMs).toISOString();
        }
      }
    }

    // 2. 429 Path
    if (status === 429) {
      current.last429At = now.toISOString();
      current.consecutive429Count++;
      current.status = 'COOLDOWN';

      const retryAfter = headers?.['retry-after'];
      let cooldownSeconds = 65; // Default for reports

      if (retryAfter) {
        cooldownSeconds = parseInt(retryAfter, 10) || 65;
      } else if (group === QuotaGroup.GET_REPORT_DOCUMENT) {
        // Severe cooldown for document metadata if persistent 429
        cooldownSeconds = current.consecutive429Count > 3 ? 900 : 65; // 15 mins if storming
      }

      current.cooldownUntil = new Date(now.getTime() + cooldownSeconds * 1000).toISOString();
      current.nextAllowedAt = current.cooldownUntil;
    }

    await this.cacheManager.set(key, current, 86400000); // 24h persistence
  }

  private getQuotaGroup(endpoint: string): QuotaGroup {
    if (endpoint.includes('/reports/2021-06-30/reports') && !endpoint.match(/\/reports\/amzn1\./))
      return QuotaGroup.CREATE_REPORT;
    if (endpoint.includes('/reports/2021-06-30/reports/')) return QuotaGroup.GET_REPORT;
    if (endpoint.includes('/reports/2021-06-30/documents/')) return QuotaGroup.GET_REPORT_DOCUMENT;
    if (endpoint.startsWith('http')) return QuotaGroup.DOWNLOAD_REPORT;
    return QuotaGroup.GENERIC;
  }

  async getAllQuotaStatus(): Promise<QuotaStatus[]> {
    const statuses: QuotaStatus[] = [];
    for (const group of Object.values(QuotaGroup)) {
      const key = `${this.QUOTA_BASE_KEY}${group}`;
      const status = await this.cacheManager.get<QuotaStatus>(key);
      if (status) statuses.push(status);
    }
    return statuses;
  }

  private updateDynamicThrottle(headers: any) {
    const rateLimitHeader = headers['x-amzn-ratelimit-limit'];
    if (rateLimitHeader) {
      const rateLimit = parseFloat(rateLimitHeader);
      if (!isNaN(rateLimit) && rateLimit > 0) {
        this.logger.debug(`[Observability] Current API Rate Limit: ${rateLimit} req/sec`);
        const requiredDelayMs = 1000 / rateLimit;
        this.nextAllowedRequestTime = Date.now() + requiredDelayMs;
      }
    }
  }

  async makeRequest<T = any>(
    method: 'GET' | 'POST' | 'PUT' | 'DELETE',
    endpoint: string,
    params?: any,
    data?: any,
  ): Promise<T> {
    const baseUrl = this.authService.getApiBaseUrl();
    const urlObj = new URL(`${baseUrl}${endpoint}`);
    if (params) {
      Object.keys(params).forEach((key) => urlObj.searchParams.append(key, params[key]));
    }

    const isReportDocumentEndpoint = endpoint.includes('/reports/2021-06-30/documents/');
    const MAX_RETRIES = this.getMaxRetries(isReportDocumentEndpoint);
    let attempt = 0;
    let hasClearedTokenCache = false;
    let lastRetryError: any = null;

    while (attempt <= MAX_RETRIES) {
      try {
        const now = Date.now();
        if (this.nextAllowedRequestTime > now) {
          await this.delay(this.nextAllowedRequestTime - now);
        }

        const accessToken = await this.authService.getAccessToken();
        const config = this.signRequest(method, urlObj, accessToken, data);

        const response: AxiosResponse<T> = await axios(config);
        this.updateDynamicThrottle(response.headers);
        await this.updateQuotaStatus(endpoint, response);
        return response.data;
      } catch (error: any) {
        lastRetryError = error;
        const status = error.response?.status;
        const safeDetails = this.safeErrorDetails(error);
        const requestId = this.getRequestId(error);

        if (error.response?.headers) {
          this.updateDynamicThrottle(error.response.headers);
        }
        await this.updateQuotaStatus(endpoint, undefined, error);

        if (this.isTransientFailure(error)) {
          if (status === 429) {
            const retryAfter = error.response?.headers?.['retry-after'];

            // Fail-fast uses per-request `attempt` counter, NOT the global
            // consecutive429Count.  Reason: the global counter spans sync runs —
            // a stale count of 4 from an hour ago would block the very next
            // request even after quota fully refills.  `attempt` resets to 0 on
            // every makeRequest() call, so 3 different documents each returning
            // one 429 will NOT trigger fail-fast; only 3 retries of the SAME
            // request (total ~195s of waiting) signals a truly exhausted quota.
            if (
              attempt >= 3 &&
              !isReportDocumentEndpoint &&
              (endpoint.includes('/documents/') || endpoint.includes('/reports/'))
            ) {
              this.logger.error(
                `[RateLimit] Quota exhausted on ${endpoint} (${attempt} retries, all 429). ` +
                  `Failing fast — retry after quota refills (~15 min). ` +
                  `Amazon burst quota: 15 req total, refill 1/60s.`,
              );
              throw error; // bubble up immediately — no more retries
            }

            let backoffMs = retryAfter
              ? (parseInt(retryAfter, 10) || 65) * 1000
              : endpoint.includes('/reports/')
                ? 65_000
                : 30_000;

            if (isReportDocumentEndpoint && attempt >= 3) {
              backoffMs = 15 * 60 * 1000;
            }

            this.logger.warn(
              `[RateLimit] 429 on ${endpoint}. Waiting ${backoffMs / 1000}s before retry ${attempt + 1}/${MAX_RETRIES}`,
            );
            await this.delay(backoffMs);
            attempt++;
            continue;
          }

          // Transient HTTP and network errors use exponential backoff with jitter.
          if (attempt < MAX_RETRIES) {
            const backoffMs = this.exponentialBackoffMs(attempt);
            this.logger.warn(
              `[Transient] ${status || error.code || 'network error'} on ${endpoint}. ` +
                `Retrying in ${backoffMs}ms (attempt ${attempt + 1}/${MAX_RETRIES})` +
                `${requestId ? ` requestId=${requestId}` : ''}`,
            );
            await this.delay(backoffMs);
            attempt++;
            continue;
          }
        }

        if (status === 401 && !hasClearedTokenCache) {
          this.logger.warn(`Unauthorized (401). Clearing token cache and retrying...`);
          await this.authService.clearTokenCache();
          hasClearedTokenCache = true;
          continue;
        }

        if (status === 403) {
          this.logger.error('IAM Policy or Developer Profile Mismatch - Check AWS Console.');
        }

        this.logger.error(
          `Amazon SP-API request failed [${status || 'No Response'}]: ${method} ${endpoint} ${safeDetails}`,
        );
        throw error;
      }
    }

    if (lastRetryError?.response?.status === 429) {
      const retryAfter = lastRetryError.response?.headers?.['retry-after'];
      const retryHint = retryAfter
        ? ` Amazon suggested retrying after ${retryAfter} seconds.`
        : ' Wait for Amazon SP-API quota to refill, then retry.';
      throw new Error(
        `Amazon SP-API quota is still exhausted for ${endpoint} after ${MAX_RETRIES + 1} attempts.${retryHint}`,
      );
    }

    throw new Error('Amazon SP-API request retry loop ended before a successful response.');
  }

  async fetchAllPages<T>(
    endpoint: string,
    params: any = {},
    dataExtractor: (response: any) => T[] = (res) => {
      if (res.payload) {
        if (Array.isArray(res.payload)) return res.payload;
        const arrayValue = Object.values(res.payload).find((val) => Array.isArray(val));
        return (arrayValue as T[]) || [];
      }
      return Array.isArray(res) ? res : [];
    },
    tokenExtractor: (response: any) => string | undefined = (res) => {
      return res.nextToken || res.pagination?.nextToken || res.payload?.nextToken;
    },
  ): Promise<T[]> {
    const allData: T[] = [];
    let currentNextToken: string | undefined = undefined;
    let pageNum = 1;

    do {
      try {
        const currentParams = { ...params };
        if (currentNextToken) {
          currentParams.nextToken = currentNextToken;
        }

        const response = await this.makeRequest<any>('GET', endpoint, currentParams);
        const records = dataExtractor(response);
        if (records && Array.isArray(records)) {
          allData.push(...records);
        }

        this.logger.log(`[Pagination] page=${pageNum} fetched=${records.length}`);
        currentNextToken = tokenExtractor(response);
        pageNum++;
      } catch (error: any) {
        this.logger.error(`Pagination failed at page ${pageNum}.`, this.safeErrorDetails(error));
        throw error;
      }
    } while (currentNextToken);

    return allData;
  }

  // ── Reports API Methods ──────────────────────────────────────────────────

  /**
   * Lists DONE reports that Amazon has already generated for the given type
   * and data period.  This mirrors the legacy approach — Amazon auto-generates
   * vendor reports on a schedule; we just fetch the existing ones.
   *
   * Sorted newest-first so callers can process the most recent report first.
   */
  async listExistingReports(
    reportType: string,
    marketplaceId: string,
    dataStartTime: string,
    dataEndTime: string,
  ): Promise<any[]> {
    return this.getReportLimiter.schedule(async () => {
      const qs = new URLSearchParams({
        reportTypes: reportType,
        processingStatuses: 'DONE',
        marketplaceIds: marketplaceId,
        pageSize: '5', // cap — we only process the 3 newest anyway
        dataStartTime,
        dataEndTime,
      });
      const endpoint = `/reports/2021-06-30/reports?${qs.toString()}`;
      const response = await this.makeRequest('GET', endpoint);
      const reports: any[] = response.reports ?? [];

      // Amazon sometimes ignores dataStartTime/dataEndTime for vendor reports
      // and returns current-period reports instead of historical ones.
      // Validate each report's actual data period before accepting it.
      const reqStart = new Date(dataStartTime).getTime();
      const reqEnd = new Date(dataEndTime).getTime();
      const filtered = reports.filter((r: any) => {
        if (!r.dataStartTime || !r.dataEndTime) return false;
        return new Date(r.dataStartTime).getTime() >= reqStart && new Date(r.dataEndTime).getTime() <= reqEnd;
      });

      if (reports.length > 0 && filtered.length === 0) {
        this.logger.warn(
          `[Reports] Amazon returned ${reports.length} pre-generated report(s) but none matched ` +
            `requested period ${dataStartTime} → ${dataEndTime}. Falling back to on-demand creation.`,
        );
      }

      // Newest first
      return filtered.sort((a: any, b: any) => new Date(b.createdTime).getTime() - new Date(a.createdTime).getTime());
    });
  }

  async createReport(
    reportType: string,
    marketplaceIds: string[],
    dataStartTime: string,
    dataEndTime: string,
    reportOptions?: any,
  ): Promise<{ reportId: string }> {
    return this.createReportLimiter.schedule(async () => {
      const endpoint = '/reports/2021-06-30/reports';
      const body = {
        reportType,
        marketplaceIds,
        dataStartTime,
        dataEndTime,
        reportOptions,
      };

      const response = await this.makeRequest('POST', endpoint, null, body);
      return { reportId: response.reportId };
    });
  }

  async getReport(reportId: string): Promise<any> {
    return this.getReportLimiter.schedule(async () => {
      const endpoint = `/reports/2021-06-30/reports/${reportId}`;
      return this.makeRequest('GET', endpoint);
    });
  }

  async getReportDocument(reportDocumentId: string): Promise<any> {
    return this.documentLimiter.schedule(async () => {
      const endpoint = `/reports/2021-06-30/documents/${reportDocumentId}`;
      return this.makeRequest('GET', endpoint);
    });
  }

  async downloadAndParseReport(url: string, compressionAlgorithm?: string): Promise<any> {
    this.logger.debug(`Downloading report document from URL...`);
    let response: AxiosResponse | undefined;
    const maxRetries = this.getMaxRetries();
    for (let attempt = 0; attempt <= maxRetries; attempt++) {
      try {
        response = await axios.get(url, {
          responseType: 'arraybuffer',
          timeout: this.getTimeoutMs(),
        });
        await this.updateQuotaStatus(url, response);
        break;
      } catch (error: any) {
        await this.updateQuotaStatus(url, undefined, error);
        if (!this.isTransientFailure(error) || attempt >= maxRetries) {
          this.logger.error(`[Download] Report download failed ${this.safeErrorDetails(error)}`);
          throw error;
        }
        const backoffMs = this.exponentialBackoffMs(attempt);
        this.logger.warn(
          `[Download] Transient failure. Retrying in ${backoffMs}ms ` + `(attempt ${attempt + 1}/${maxRetries})`,
        );
        await this.delay(backoffMs);
      }
    }
    if (!response) throw new Error('Amazon report download ended without a response.');
    let data = response.data;

    if (compressionAlgorithm === 'GZIP') {
      this.logger.debug(`Decompressing GZIP report document...`);
      data = await gunzip(data);
    }

    const content = data.toString('utf-8');

    // Try to parse as JSON first, then fallback to raw content (might be TSV)
    try {
      return JSON.parse(content);
    } catch (e) {
      return content;
    }
  }

  getRateLimitConfig() {
    return {
      createReport: { minTime: 65000, maxConcurrent: 1 },
      getReport: { minTime: 2000, maxConcurrent: 1 },
      getReportDocument: { minTime: 65000, maxConcurrent: 1 },
    };
  }
}
