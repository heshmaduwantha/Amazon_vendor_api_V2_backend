import { Column, Entity, PrimaryColumn, UpdateDateColumn } from 'typeorm';

export type InventorySchedulerLastRunStatus = 'NEVER' | 'RUNNING' | 'SUCCESS' | 'FAILED';

export interface InventorySchedulerWeekRange {
  amazonYear: number;
  weekNumber: number;
  label: string;
  startDate: string;
  endDate: string;
}

@Entity('inventory_scheduler_settings')
export class InventorySchedulerSettingsEntity {
  @PrimaryColumn({ type: 'varchar', default: 'inventory' })
  id: 'inventory';

  @Column({ type: 'boolean', default: true })
  enabled: boolean;

  @Column({ type: 'int', name: 'day_of_week', default: 0 })
  dayOfWeek: number;

  @Column({ type: 'varchar', name: 'time_of_day', default: '22:00' })
  timeOfDay: string;

  @Column({ type: 'varchar', default: 'America/New_York' })
  timezone: string;

  @Column({ type: 'varchar', name: 'last_run_status', default: 'NEVER' })
  lastRunStatus: InventorySchedulerLastRunStatus;

  @Column({ type: 'timestamp', name: 'last_run_started_at', nullable: true })
  lastRunStartedAt: Date | null;

  @Column({ type: 'timestamp', name: 'last_run_finished_at', nullable: true })
  lastRunFinishedAt: Date | null;

  @Column({ type: 'varchar', name: 'last_run_error', nullable: true })
  lastRunError: string | null;

  @Column({ type: 'simple-json', name: 'last_run_week_ranges', nullable: true })
  lastRunWeekRanges: InventorySchedulerWeekRange[] | null;

  @UpdateDateColumn({ type: 'timestamp', name: 'updated_at' })
  updatedAt: Date;
}
