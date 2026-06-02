import { Controller, Get, ForbiddenException, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { AmazonApiService } from './amazon-api.service';
import * as aws4 from 'aws4';

/**
 * SigV4 Smoke Test Controller
 *
 * Validates that the aws4 signing utility generates correct Authorization and
 * x-amz-date headers using the configured AWS IAM credentials.
 *
 * GUARD: This endpoint is disabled when NODE_ENV === 'production'.
 * No real SP-API call is made. No credentials are exposed in the response.
 */
@Controller('amazon-api')
export class AmazonApiController {
  private readonly logger = new Logger(AmazonApiController.name);

  constructor(
    private readonly configService: ConfigService,
    private readonly amazonApiService: AmazonApiService,
  ) {}

  @Get('sigv4-smoke-test')
  sigV4SmokeTest() {
    // ── Production guard ──────────────────────────────────────────────────────
    if (this.configService.get<string>('NODE_ENV') === 'production') {
      throw new ForbiddenException(
        'SigV4 smoke test endpoint is disabled in production.',
      );
    }

    // ── Load credentials from environment (never hard-coded) ─────────────────
    const accessKeyId = this.configService.get<string>('SP_API_AWS_ACCESS_KEY_ID');
    const secretAccessKey = this.configService.get<string>('SP_API_AWS_SECRET_ACCESS_KEY');
    const region = this.configService.get<string>('AWS_REGION') || 'us-east-1';
    const service = 'execute-api';

    if (!accessKeyId || !secretAccessKey) {
      return {
        ok: false,
        error: 'Missing SP_API_AWS_ACCESS_KEY_ID or SP_API_AWS_SECRET_ACCESS_KEY in environment.',
        hasAuthorizationHeader: false,
        hasXAmzDate: false,
        region,
        service,
      };
    }

    // ── Build a dummy signed request (no network call) ────────────────────────
    const signOptions: aws4.Request = {
      host: 'sellingpartnerapi-na.amazon.com',
      path: '/vendors/orders/v1/purchaseOrders?smoke-test=true',
      method: 'GET',
      headers: {
        'x-amz-access-token': 'smoke-test-token-placeholder',
        'Content-Type': 'application/json',
        'Accept': 'application/json',
      },
      region,
      service,
    };

    aws4.sign(signOptions, { accessKeyId, secretAccessKey });

    const signedHeaders = signOptions.headers as Record<string, string>;

    // ── Return safe metadata only — no raw credential values ─────────────────
    return {
      ok: true,
      hasAuthorizationHeader: !!signedHeaders['Authorization'],
      hasXAmzDate: !!signedHeaders['X-Amz-Date'],
      region,
      service,
      // Partial prefix of Authorization header to confirm signing algorithm
      authorizationAlgorithm: signedHeaders['Authorization']
        ? signedHeaders['Authorization'].split(' ')[0]  // e.g. "AWS4-HMAC-SHA256"
        : null,
    };
  }

  /**
   * Experimental LWA-Only Auth Test
   * 
   * Calls /sellers/v1/marketplaceParticipations to verify if LWA-only
   * authentication is sufficient.
   */
  @Get('auth-test')
  async authTest() {
    // ── Production guard ──────────────────────────────────────────────────────
    if (this.configService.get<string>('NODE_ENV') === 'production') {
      throw new ForbiddenException(
        'Auth test endpoint is disabled in production.',
      );
    }

    const useSigV4 = this.configService.get<string>('USE_SIGV4') !== 'false';
    const endpoint = '/sellers/v1/marketplaceParticipations';

    this.logger.log(`[Experimental] Starting Auth Test. Mode: ${useSigV4 ? 'SigV4' : 'LWA-Only'}`);

    try {
      const response = await this.amazonApiService.makeRequest('GET', endpoint);
      
      // Extract marketplaces from response if possible
      const marketplaces = (response as any)?.payload || response;

      return {
        ok: true,
        mode: useSigV4 ? 'SigV4' : 'LWA-Only',
        message: 'Authorization successful.',
        marketplaces,
      };
    } catch (error: any) {
      const status = error.response?.status;
      const amazonErrorCode = error.response?.data?.errors?.[0]?.code || 'UNKNOWN';
      const reason = error.response?.data?.errors?.[0]?.message || error.message;

      this.logger.error(`[Auth-Test] Failure. Status: ${status}, AmazonCode: ${amazonErrorCode}, Reason: ${reason}`);

      return {
        ok: false,
        mode: useSigV4 ? 'SigV4' : 'LWA-Only',
        status,
        amazonErrorCode,
        reason: reason,
        sigV4Required: status === 403 && amazonErrorCode === 'AccessDenied',
      };
    }
  }

  @Get('compatibility-check')
  async compatibilityCheck() {
    return {
      apiBaseUrl: this.configService.get<string>('AMAZON_API_BASE_URL'),
      useSigV4: this.configService.get<string>('USE_SIGV4') !== 'false',
      marketplaceId: this.configService.get<string>('MARKETPLACE_ID') || 'ATVPDKIKX0DER',
      nodeEnv: this.configService.get<string>('NODE_ENV'),
      rateLimiters: this.amazonApiService.getRateLimitConfig(),
      salesAggregateEnabled: true,
      inventoryLegacyOptionsEnabled: true,
      reportsHardeningEnabled: true,
      status: 'OK'
    };
  }

  @Get('quota-status')
  async getQuotaStatus() {
    return await this.amazonApiService.getAllQuotaStatus();
  }
}
