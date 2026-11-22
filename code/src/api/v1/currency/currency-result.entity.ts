import { Type, Expose } from 'class-transformer';
import { IsDefined, ValidateNested } from 'class-validator';

import { CurrencyEntity } from './currency.entity';
import { MetaEntity } from './meta.entity';

export class CurrencyResultEntity {
  @Expose()
  @ValidateNested()
  @Type(() => CurrencyEntity)
  items: CurrencyEntity[];

  @Expose()
  @IsDefined()
  @ValidateNested()
  @Type(() => MetaEntity)
  meta: MetaEntity;
}
