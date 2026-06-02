import { Injectable, Logger, Inject } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { CACHE_MANAGER } from '@nestjs/cache-manager';
import type { Cache } from 'cache-manager';
import axios from 'axios';
import { maskSecret } from '../utils/mask-secret.util';

@Injectable()
export class AuthService {
  private readonly logger = new Logger(AuthService.name);
  private readonly TOKEN_CACHE_KEY = 'amazon_sp_api_token';

  constructor(
    private configService: ConfigService,
    @Inject(CACHE_MANAGER) private cacheManager: Cache,
  ) {}

  async getAccessToken(): Promise<string> {
    const cached = await this.cacheManager.get<string>(this.TOKEN_CACHE_KEY);
    if (cached) {
      return cached;
    }

    return this.fetchNewToken();
  }

  async clearTokenCache() {
    this.logger.warn('Invalidating SP-API access token cache due to unauthorized error.');
    await this.cacheManager.del(this.TOKEN_CACHE_KEY);
  }

  private async fetchNewToken(): Promise<string> {
    const clientId = this.configService.get<string>('LWA_CLIENT_ID') || 
                     this.configService.get<string>('SP_API_CLIENT_ID');
    const clientSecret = this.configService.get<string>('LWA_CLIENT_SECRET') || 
                         this.configService.get<string>('SP_API_CLIENT_SECRET');
    const refreshToken = this.configService.get<string>('REFRESH_TOKEN') || 
                         this.configService.get<string>('SP_API_REFRESH_TOKEN');
    const lwaEndpoint = this.configService.get<string>('LWA_ENDPOINT') || 'https://api.amazon.com/auth/o2/token';

    if (!clientId || !clientSecret || !refreshToken) {
      this.logger.error(`Missing required LWA environment variables: 
        LWA_CLIENT_ID/SP_API_CLIENT_ID: ${!!clientId}, 
        LWA_CLIENT_SECRET/SP_API_CLIENT_SECRET: ${!!clientSecret}, 
        REFRESH_TOKEN/SP_API_REFRESH_TOKEN: ${!!refreshToken}`);
      throw new Error('Missing required LWA environment variables.');
    }

    try {
      const response = await axios.post(lwaEndpoint, {
        grant_type: 'refresh_token',
        refresh_token: refreshToken,
        client_id: clientId,
        client_secret: clientSecret,
      });

      const data = response.data;
      const accessToken = data.access_token;
      // Subtract 5 minutes from expiry for safety buffer
      const ttlMs = (data.expires_in - 300) * 1000;
      
      await this.cacheManager.set(this.TOKEN_CACHE_KEY, accessToken, ttlMs);
      
      this.logger.log(`Successfully fetched and cached new LWA token.`);
      return accessToken;
    } catch (error: any) {
      const errorMsg = JSON.stringify(error.response?.data || error.message);
      this.logger.error('Failed to fetch new SP-API access token', maskSecret(errorMsg));
      throw error;
    }
  }

  getAwsCredentials() {
    return {
      accessKeyId: this.configService.get<string>('SP_API_AWS_ACCESS_KEY_ID'),
      secretAccessKey: this.configService.get<string>('SP_API_AWS_SECRET_ACCESS_KEY'),
      region: this.configService.get<string>('AWS_REGION') || 'us-east-1',
    };
  }

  getApiBaseUrl(): string {
    return this.configService.get<string>('AMAZON_API_BASE_URL') || 'https://sellingpartnerapi-na.amazon.com';
  }
}
