import { CursorPagination, CursorQueryDto } from '@sellgar/pagination';
import { Injectable } from '@nestjs/common';
import { InjectDataSource } from '@nestjs/typeorm';
import { plainToInstance } from 'class-transformer';
import { validateOrReject } from 'class-validator';
import { DataSource } from 'typeorm';

import { CreateCurrencyDto } from './dto/create-currency.dto';
import { UpdateCurrencyDto } from './dto/update-currency.dto';
import { CurrencyEntity } from '../currency.entity';
import { CurrencyModel } from '../currency.model';

@Injectable()
export class CurrencyRepository {
  constructor(
    @InjectDataSource() private readonly dataSource: DataSource,
    private readonly pagination: CursorPagination,
  ) {}

  async findAll(query: Partial<CursorQueryDto> = {}) {
    const page = await this.pagination.read(this.dataSource.createQueryBuilder(CurrencyModel, 'currency'), query, {
      scope: 'store.currency.list',
      filters: {},
      order: [
        { expression: 'currency.order', direction: 'ASC', type: 'integer' },
        { expression: 'currency.code', direction: 'ASC', type: 'text' },
      ],
    });
    const items = page.items.map((entity) => this.toEntity(entity));
    await Promise.all(items.map((entity) => validateOrReject(entity)));
    return { items, meta: page.meta };
  }

  async findByCode(code: string) {
    const result = await this.dataSource
      .createQueryBuilder(CurrencyModel, 'currency')
      .where('currency.code = :code', { code })
      .getOneOrFail();

    const resultInstance = this.toEntity(result);

    await validateOrReject(resultInstance);

    return resultInstance;
  }

  async create(dto: CreateCurrencyDto) {
    await this.dataSource.manager.insert(CurrencyModel, dto);

    return this.findByCode(dto.code);
  }

  async update(dto: UpdateCurrencyDto) {
    await this.dataSource.manager.update(CurrencyModel, { code: dto.code }, dto);

    return this.findByCode(dto.code);
  }

  async remove(code: string) {
    const result = await this.findByCode(code);

    await this.dataSource.manager.delete(CurrencyModel, { code });

    return result;
  }

  private toEntity(entity: CurrencyModel) {
    return plainToInstance(CurrencyEntity, entity, {
      strategy: 'excludeAll',
    });
  }
}
