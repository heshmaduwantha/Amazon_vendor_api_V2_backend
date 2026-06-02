import { Entity, PrimaryGeneratedColumn, Column } from 'typeorm';

@Entity('report_status')
export class ReportStatusEntity {
  @PrimaryGeneratedColumn()
  id: number;

  @Column({ type: 'varchar' })
  reportType: string;

  @Column({ type: 'varchar', unique: true, nullable: true })
  reportId: string;

  @Column({ type: 'varchar', nullable: true })
  reportDocumentId: string;

  @Column({ type: 'timestamp', nullable: true })
  dataStartTime: Date;

  @Column({ type: 'timestamp', nullable: true })
  dataEndTime: Date;

  @Column({ type: 'varchar', default: 'IN_PROGRESS' })
  status: string;

  @Column({ type: 'varchar', nullable: true })
  errorMessage: string;

  @Column({ type: 'int', default: 0 })
  retryCount: number;
}
