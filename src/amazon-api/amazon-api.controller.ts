import { Controller, Get, ForbiddenException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
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
  constructor(private readonly configService: ConfigService) {}

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
}
