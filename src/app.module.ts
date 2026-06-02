import { Module, Logger } from '@nestjs/common';
import { ConfigModule, ConfigService } from '@nestjs/config';
import { TypeOrmModule } from '@nestjs/typeorm';
import { ScheduleModule } from '@nestjs/schedule';
import { CacheModule } from '@nestjs/cache-manager';
import { AppController } from './app.controller';
import { AppService } from './app.service';
import { AuthModule } from './auth/auth.module';
import { AmazonApiModule } from './amazon-api/amazon-api.module';
import { SalesModule } from './reports/sales/sales.module';
import { InventoryModule } from './reports/inventory/inventory.module';
import { SyncModule } from './sync/sync.module';
import { CommonModule } from './common/common.module';
import { ForecastModule } from './reports/forecast/forecast.module';
import { ReportStatusEntity } from './common/entities/report-status.entity';
import { AmazonForecastByAsin } from './reports/forecast/entities/amazon-forecast-by-asin.entity';

const cacheLogger = new Logger('CacheModule');

@Module({
  imports: [
    ConfigModule.forRoot({ isGlobal: true }),

    // ── Database ─────────────────────────────────────────────────────────────
    // getOrThrow() — if any required var is missing the app refuses to start
    // and prints a clear "Missing environment variable" error immediately.
    // Never falls back to hardcoded values — use .env for every environment.
    TypeOrmModule.forRootAsync({
      imports: [ConfigModule],
      useFactory: (configService: ConfigService) => ({
        type: 'postgres',
        host:     configService.getOrThrow<string>('DB_HOST'),
        port:     parseInt(configService.getOrThrow<string>('DB_PORT'), 10),
        username: configService.getOrThrow<string>('DB_USER'),
        password: configService.getOrThrow<string>('DB_PASS'),
        database: configService.getOrThrow<string>('DB_NAME'),
        autoLoadEntities: true,
        synchronize: true,
        entities: [ReportStatusEntity, AmazonForecastByAsin],
        logging: configService.get<string>('NODE_ENV') === 'development' ? ['error', 'warn'] : false,
      }),
      inject: [ConfigService],
    }),

    // ── Cache (Redis with in-memory fallback) ─────────────────────────────────
    // Phase 2: Redis stores auth tokens, sync status & distributed locks so they
    // survive restarts and are shared if you ever run multiple instances.
    //
    // Strategy: TCP-probe Redis BEFORE creating the ioredis store.
    // If the probe fails we use in-memory immediately — the ioredis client is
    // never created, so there are zero retry loops or unhandled error events.
    CacheModule.registerAsync({
      isGlobal: true,
      imports: [ConfigModule],
      useFactory: async (configService: ConfigService) => {
        const host = configService.get<string>('REDIS_HOST') || 'localhost';
        const port = parseInt(configService.get<string>('REDIS_PORT') || '6379', 10);

        // ── Step 1: lightweight TCP probe (no ioredis, no retries) ────────────
        const redisAvailable = await new Promise<boolean>(resolve => {
          // eslint-disable-next-line @typescript-eslint/no-var-requires
          const net = require('net') as typeof import('net');
          const socket = new net.Socket();
          socket.setTimeout(2000);
          socket.once('connect', () => { socket.destroy(); resolve(true);  });
          socket.once('error',   () => { socket.destroy(); resolve(false); });
          socket.once('timeout', () => { socket.destroy(); resolve(false); });
          socket.connect(port, host);
        });

        if (!redisAvailable) {
          cacheLogger.warn(
            `⚠️  Redis not reachable at ${host}:${port}. ` +
            `Using in-memory cache — token + sync state will reset on restart.`,
          );
          return { ttl: 3_600_000 }; // 1 hour in-memory fallback
        }

        // ── Step 2: Redis is up — create the real store ───────────────────────
        try {
          const { redisStore } = await import('cache-manager-ioredis-yet');
          const store = await redisStore({ host, port, connectTimeout: 3000 } as any);
          cacheLogger.log(`✅ Redis cache connected at ${host}:${port}`);
          return { store };
        } catch (err: any) {
          cacheLogger.warn(`⚠️  Redis store error: ${err.message}. Falling back to in-memory.`);
          return { ttl: 3_600_000 };
        }
      },
      inject: [ConfigService],
    }),

    ScheduleModule.forRoot(),
    CommonModule,
    AuthModule,
    AmazonApiModule,
    SalesModule,
    InventoryModule,
    ForecastModule,
    SyncModule,
  ],
  controllers: [AppController],
  providers: [AppService],
})
export class AppModule {}
