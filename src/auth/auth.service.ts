import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import axios from 'axios';
import { maskSecret } from '../utils/mask-secret.util';

@Injectable()
export class AuthService {
  private readonly logger = new Logger(AuthService.name);
  
  private cachedToken: string | null = null;
  private tokenExpirationTime: number | null = null;

  constructor(private configService: ConfigService) {}

  async getAccessToken(): Promise<string> {
    const safetyBufferMs = 5 * 60 * 1000;
    const currentTimeMs = Date.now();

    if (
      this.cachedToken &&
      this.tokenExpirationTime &&
      this.tokenExpirationTime - currentTimeMs > safetyBufferMs
    ) {
      return this.cachedToken;
    }

    return this.fetchNewToken();
  }

  clearTokenCache() {
    this.logger.warn('Invalidating SP-API access token cache due to unauthorized error.');
    this.cachedToken = null;
    this.tokenExpirationTime = null;
  }

  private async fetchNewToken(): Promise<string> {
    const clientId = this.configService.get<string>('LWA_CLIENT_ID');
    const clientSecret = this.configService.get<string>('LWA_CLIENT_SECRET');
    const refreshToken = this.configService.get<string>('REFRESH_TOKEN');
    const lwaEndpoint = this.configService.get<string>('LWA_ENDPOINT') || 'https://api.amazon.com/auth/o2/token';

    if (!clientId || !clientSecret || !refreshToken) {
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
      this.cachedToken = data.access_token;
      this.tokenExpirationTime = Date.now() + (data.expires_in * 1000);
      
      this.logger.log(`Successfully fetched new LWA token.`);
      return this.cachedToken as string;
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
