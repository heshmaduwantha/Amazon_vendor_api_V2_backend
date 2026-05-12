import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import axios, { AxiosRequestConfig, AxiosResponse } from 'axios';
import * as aws4 from 'aws4';
import { URL } from 'url';
import { AuthService } from '../auth/auth.service';
import { normalizeDateToUTC } from '../utils/date.util';
import { maskSecret } from '../utils/mask-secret.util';

@Injectable()
export class AmazonApiService {
  private readonly logger = new Logger(AmazonApiService.name);
  private nextAllowedRequestTime: number = 0;

  constructor(
    private readonly authService: AuthService,
    private readonly configService: ConfigService,
  ) {}

  normalizeDate(date: string | Date, type: 'start' | 'end'): string {
    return normalizeDateToUTC(date, type);
  }

  private delay(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }

  private signRequest(
    method: string,
    url: URL,
    accessToken: string,
    data?: any,
  ): AxiosRequestConfig {
    const useSigV4 = this.configService.get<string>('USE_SIGV4') !== 'false';
    const credentials = this.authService.getAwsCredentials();

    const headers: Record<string, string> = {
      'x-amz-access-token': accessToken,
      'Content-Type': 'application/json',
      'Accept': 'application/json',
    };

    if (!useSigV4) {
      this.logger.debug(`[Auth] Using LWA-only authentication (SigV4 disabled).`);
      return {
        method,
        url: url.toString(),
        headers,
        data,
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
    };
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
      Object.keys(params).forEach(key => urlObj.searchParams.append(key, params[key]));
    }
    
    const MAX_RETRIES = 5;
    const INITIAL_BACKOFF_MS = 1000;
    let attempt = 0;
    let hasClearedTokenCache = false;

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
        return response.data;

      } catch (error: any) {
        const status = error.response?.status;
        const errorData = JSON.stringify(error.response?.data || error.message);
        
        if (error.response?.headers) {
          this.updateDynamicThrottle(error.response.headers);
        }

        if (status === 429 || (status >= 500 && status <= 599)) {
          if (attempt < MAX_RETRIES) {
            const backoffMs = INITIAL_BACKOFF_MS * Math.pow(2, attempt) + Math.floor(Math.random() * 500);
            this.logger.warn(`Transient error ${status} on ${endpoint}. Retrying... (Attempt ${attempt + 1})`);
            await this.delay(backoffMs);
            attempt++;
            continue;
          }
        }

        if (status === 401 && !hasClearedTokenCache) {
          this.logger.warn(`Unauthorized (401). Clearing token cache and retrying...`);
          this.authService.clearTokenCache();
          hasClearedTokenCache = true;
          continue;
        }

        if (status === 403) {
          this.logger.error("IAM Policy or Developer Profile Mismatch - Check AWS Console.");
        }

        this.logger.error(`Amazon SP-API request failed [${status || 'No Response'}]: ${method} ${endpoint}`, maskSecret(errorData));
        throw error;
      }
    }

    throw new Error('Unexpected exit from makeRequest retry loop');
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

        currentNextToken = tokenExtractor(response);
        pageNum++;
      } catch (error: any) {
        this.logger.error(`Pagination stopped gracefully at page ${pageNum} due to error.`, maskSecret(error.message));
        break;
      }
    } while (currentNextToken);

    return allData;
  }
}
