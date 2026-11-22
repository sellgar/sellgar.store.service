import { Expose } from 'class-transformer';
import { IsDate, IsNumber, IsString } from 'class-validator';

export class CurrencyEntity {
  @Expose()
  @IsString()
  code: string;

  @Expose()
  @IsString()
  value: string;

  @Expose()
  @IsNumber()
  order: number;

  @Expose()
  @IsDate()
  createdAt: Date;

  @Expose()
  @IsDate()
  updatedAt: Date;
}
