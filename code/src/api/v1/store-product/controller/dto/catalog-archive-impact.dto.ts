import { IsOptional, IsUUID } from 'class-validator';

export class CatalogArchiveImpactDto {
  @IsUUID()
  productUuid: string;

  @IsOptional()
  @IsUUID()
  variantUuid?: string;
}
