# Code Examples

## Portage Backend — Creating a NestJS Module {#wiki-code-examples-portage-backend-creating-a-nestjs-module}

**1. Generate the module:**

```bash
nest g module apps/api/src/my-feature
nest g controller apps/api/src/my-feature
nest g service apps/api/src/my-feature
```

**2. Controller with permissions and Swagger (real pattern from trip-request.controller.ts):**

```typescript
// apps/api/src/my-feature/my-feature.controller.ts
import { Controller, Post, Body, Req, Delete, Param } from '@nestjs/common';
import { ApiTags, ApiOperation, ApiResponse } from '@nestjs/swagger';
import { Request } from 'express';
import { Permission } from '../common/decorator/auth.decorator';
import { RefFeature, RefPermission } from '@app/common/types';
import { MyFeatureService } from './my-feature.service';
import { CreateMyFeatureDto } from './dto/create-my-feature.dto';
import { GetListMyFeatureDto } from './dto/get-list-my-feature.dto';
import { Response200 } from '@app/response-codes';

@ApiTags('My Feature')
@Controller('my-feature')
export class MyFeatureController {
  constructor(private readonly service: MyFeatureService) {}

  @Post()
  @Permission({ feature: RefFeature.MY_FEATURE, type: RefPermission.ADD })
  @ApiOperation({ summary: 'Create a new record' })
  async create(@Body() dto: CreateMyFeatureDto, @Req() req: Request) {
    const result = await this.service.create(req.context, dto);
    return Response200.asApiResponse(result);
  }

  @Post('list/get')
  @Permission({ feature: RefFeature.MY_FEATURE, type: RefPermission.VIEW })
  @ApiOperation({ summary: 'List records with pagination' })
  async list(@Body() dto: GetListMyFeatureDto, @Req() req: Request) {
    const result = await this.service.getList(req.context, dto);
    return Response200.asApiResponse(result);
  }

  @Post('get/:id')
  @Permission({ feature: RefFeature.MY_FEATURE, type: RefPermission.VIEW })
  async findOne(@Param('id') id: number, @Req() req: Request) {
    const result = await this.service.findOne(req.context, id);
    return Response200.asApiResponse(result);
  }

  @Post('update')
  @Permission({ feature: RefFeature.MY_FEATURE, type: RefPermission.EDIT })
  async update(@Body() dto: UpdateMyFeatureDto, @Req() req: Request) {
    const result = await this.service.update(req.context, dto);
    return Response200.asApiResponse(result);
  }

  @Delete(':id')
  @Permission({ feature: RefFeature.MY_FEATURE, type: RefPermission.DELETE })
  async remove(@Param('id') id: number, @Req() req: Request) {
    await this.service.remove(req.context, id);
    return Response200.asApiResponse(null);
  }
}
```

**3. Service with Prisma and context (real pattern from trip-request.service.ts):**

```typescript
// apps/api/src/my-feature/my-feature.service.ts
import { Injectable } from '@nestjs/common';
import { TtContext } from '@app/common';
import { CreateMyFeatureDto } from './dto/create-my-feature.dto';
import { GetListMyFeatureDto } from './dto/get-list-my-feature.dto';

@Injectable()
export class MyFeatureService {
  async create(ctx: TtContext, dto: CreateMyFeatureDto) {
    return ctx.prisma.my_feature.create({
      data: {
        ...dto,
        created: Math.floor(Date.now() / 1000),
      },
    });
  }

  async getList(ctx: TtContext, dto: GetListMyFeatureDto) {
    const { skip, take, sortList, filters } = dto;

    const where = this.buildWhere(filters);
    const orderBy = this.buildOrderBy(sortList);

    const [records, totalCount] = await Promise.all([
      ctx.prisma.my_feature.findMany({
        where,
        orderBy,
        skip,
        take,
      }),
      ctx.prisma.my_feature.count({ where }),
    ]);

    return { records, totalCount };
  }

  async findOne(ctx: TtContext, id: number) {
    return ctx.prisma.my_feature.findUnique({
      where: { id },
      include: { relations: true },
    });
  }

  async update(ctx: TtContext, dto: UpdateMyFeatureDto) {
    const { id, ...data } = dto;
    return ctx.prisma.my_feature.update({
      where: { id },
      data: { ...data },
    });
  }

  async remove(ctx: TtContext, id: number) {
    return ctx.prisma.my_feature.delete({ where: { id } });
  }

  private buildWhere(filters: Record<string, any>) {
    const where: any = {};
    for (const [field, value] of Object.entries(filters)) {
      if (value) {
        where[field] = { contains: value };
      }
    }
    return where;
  }

  private buildOrderBy(sortList: { field: string; direction: string }[]) {
    if (!sortList?.length) return { created: 'desc' };
    return sortList.reduce(
      (acc, s) => ({
        ...acc,
        [s.field]: s.direction === 'desc' ? 'desc' : 'asc',
      }),
      {}
    );
  }
}
```

**4. DTO with validation (real pattern from create-trip-request.dto.ts):**

```typescript
// apps/api/src/my-feature/dto/create-my-feature.dto.ts
import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { IsString, IsOptional, IsInt, Min, IsBoolean, IsArray, ValidateNested } from 'class-validator';
import { Type } from 'class-transformer';

export class CreateMyFeatureDto {
  @ApiProperty()
  @IsString()
  name: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  description?: string;

  @ApiProperty()
  @IsInt()
  @Min(1)
  location_id: number;

  @ApiPropertyOptional()
  @IsOptional()
  @IsBoolean()
  is_active?: boolean;
}

export class GetListMyFeatureDto {
  @ApiProperty({ default: 0 })
  @IsInt()
  @Min(0)
  skip: number;

  @ApiProperty({ default: 20 })
  @IsInt()
  @Min(1)
  take: number;

  @ApiPropertyOptional()
  @IsOptional()
  @IsArray()
  sortList?: { field: string; direction: string }[];

  @ApiPropertyOptional()
  @IsOptional()
  filters?: Record<string, any>;
}
```

**5. Register in api.module.ts:**

```typescript
import { MyFeatureModule } from './my-feature/my-feature.module';

@Module({
  imports: [
    // ... existing modules
    MyFeatureModule,
  ],
})
export class ApiModule {}
```

---

---

## Portage Backend — Emitting a Domain Event {#wiki-code-examples-portage-backend-emitting-a-domain-event}

**Define the event class:**

```typescript
// apps/api/src/event-handler/my-feature/my-feature-create.event.ts
import { TtContext } from '@app/common';
import { my_feature } from '@app/client';

export class MyFeatureCreateEvent {
  constructor(
    public ttContext: TtContext,
    public newValue: my_feature
  ) {}
}
```

**Emit from a service:**

```typescript
import { Injectable } from '@nestjs/common';
import { EventEmitter2 } from '@nestjs/event-emitter';
import { TtContext } from '@app/common';
import { TtEventType } from '../event-handler/event.type';
import { MyFeatureCreateEvent } from '../event-handler/my-feature/my-feature-create.event';

@Injectable()
export class MyFeatureService {
  constructor(private eventEmitter: EventEmitter2) {}

  async create(ctx: TtContext, dto: CreateMyFeatureDto) {
    const record = await ctx.prisma.my_feature.create({
      data: { ...dto, created: Math.floor(Date.now() / 1000) },
    });

    this.eventEmitter.emit(TtEventType.MY_FEATURE_CREATE, new MyFeatureCreateEvent(ctx, record));

    return record;
  }
}
```

**Handle the event:**

```typescript
// apps/api/src/event-handler/my-feature/my-feature-handler.service.ts
import { Injectable } from '@nestjs/common';
import { OnEvent } from '@nestjs/event-emitter';
import { TtEventType } from '../event.type';
import { MyFeatureCreateEvent } from './my-feature-create.event';

@Injectable()
export class MyFeatureHandlerService {
  @OnEvent(TtEventType.MY_FEATURE_CREATE)
  async handleCreate(event: MyFeatureCreateEvent) {
    const { ttContext, newValue } = event;
    // Send notification, update audit log, sync to other systems, etc.
  }

  @OnEvent(TtEventType.MY_FEATURE_UPDATE)
  async handleUpdate(event: MyFeatureUpdateEvent) {
    const { ttContext, newValue, oldValue } = event;
    // Log field-level changes, trigger downstream updates
  }
}
```

---

---

## Portage Backend — Using Kafka to Queue a Job {#wiki-code-examples-portage-backend-using-kafka-to-queue-a-job}

**API app — producer (using KafkaApiService):**

```typescript
import { Injectable } from '@nestjs/common';
import { KafkaApiService, QueueEventTopic } from '@app/kafka';
import { TtContext } from '@app/common';

@Injectable()
export class NotificationService {
  constructor(private kafka: KafkaApiService) {}

  async queueEmail(ctx: TtContext, to: string, subject: string, body: string) {
    await this.kafka.send(QueueEventTopic.SEND_EMAIL, {
      clientId: ctx.client,
      to,
      subject,
      body,
    });
  }

  async queueSms(ctx: TtContext, phone: string, message: string) {
    await this.kafka.send(QueueEventTopic.SEND_SMS, {
      clientId: ctx.client,
      phone,
      message,
    });
  }
}
```

**Queue app — consumer (using Bull + Kafka):**

```typescript
import { Process, Processor } from '@nestjs/bull';
import { Job } from 'bull';
import { Injectable } from '@nestjs/common';

@Processor('email-queue')
@Injectable()
export class EmailConsumer {
  @Process('send-email')
  async handleSendEmail(job: Job) {
    const { clientId, to, subject, body } = job.data;
    // Process the email send
  }
}
```

---

---

## Portage Frontend — API Call Patterns {#wiki-code-examples-portage-frontend-api-call-patterns}

**Real patterns from `useFetchApi.ts`:**

```typescript
// List with filters
const { data, pending, refresh } = useFetchApi('/api/v2/my-feature/list/get', {
  method: 'POST',
  body: {
    skip: 0,
    take: 50,
    sortList: [{ field: 'name', direction: 'asc' }],
    filters: { name: 'test' },
  },
});

// Create
const { data, error } = await useFetchApi('/api/v2/my-feature', {
  method: 'POST',
  body: { name: 'Test', location_id: 1 },
});

// Update
const { data, error } = await useFetchApi('/api/v2/my-feature/update', {
  method: 'POST',
  body: { id: 123, name: 'Updated Name' },
});

// Delete
const { data, error } = await useFetchApi('/api/v2/my-feature/123', {
  method: 'DELETE',
});

// Blob download (PDF, CSV, etc.)
const { data, contentDisposition } = await useFetchApi(
  '/api/v2/my-feature/export',
  { method: 'POST', body: { filters: {} } },
  { responseType: 'blob' }
);
// data is a Blob, contentDisposition has the filename

// Note: useFetchApi returns unwrapped data:
// return { data: data.value?.data, pending, error, refresh, userError, cancel }
// So data.value is already one level deep from the API response
```

---

---

## Portage Frontend — Creating a Page {#wiki-code-examples-portage-frontend-creating-a-page}

**Real pattern from `pages/[client]/trip-requests/index.vue`:**

```vue
<!-- pages/[client]/my-feature/index.vue -->
<script setup lang="ts">
import { defineAsyncComponent } from 'vue';

const MyFeatureList = defineAsyncComponent(() => import('../../../modules/my-feature/MyFeatureList.vue'));
</script>

<template>
  <MyFeatureList />
</template>
```

**Real pattern from `pages/[client]/trip-requests/[id].vue`:**

```vue
<!-- pages/[client]/my-feature/[id].vue -->
<script setup lang="ts">
import { useRoute, useRouter } from 'vue-router';
import { defineAsyncComponent } from 'vue';

const MyFeatureViewEdit = defineAsyncComponent(() => import('../../../modules/my-feature/MyFeatureViewEdit.vue'));

const route = useRoute();
const router = useRouter();

const id = computed(() => {
  const param = route.params.id;
  return Array.isArray(param) ? Number(param[0]) : Number(param);
});

const goBack = () => {
  router.push(`/${route.params.client}/my-feature`);
};
</script>

<template>
  <MyFeatureViewEdit :id="id" @goBack="goBack" />
</template>
```

---

---

## Portage Frontend — Creating a Pinia Store {#wiki-code-examples-portage-frontend-creating-a-pinia-store}

**Real pattern from `stores/trips/tripRequest.ts` and `stores/trips/tripApproval.ts`:**

```typescript
// stores/my-feature.ts
import { defineStore } from 'pinia';
import { ref } from 'vue';
import type { MyFeatureRecord } from '~/utils/types';

export const useMyFeatureStore = defineStore('myFeature', () => {
  const items = ref<MyFeatureRecord[]>([]);
  const loading = ref(false);
  const totalCount = ref(0);
  const currentItem = ref<MyFeatureRecord | null>(null);

  async function fetchList(params = {}) {
    loading.value = true;
    const { data, error } = await useFetchApi('/api/v2/my-feature/list/get', {
      method: 'POST',
      body: { skip: 0, take: 20, sortList: [], filters: {}, ...params },
    });
    loading.value = false;

    if (data.value) {
      items.value = data.value.records;
      totalCount.value = data.value.totalCount;
    }
  }

  async function fetchOne(id: number) {
    const { data } = await useFetchApi(`/api/v2/my-feature/get/${id}`, {
      method: 'POST',
    });
    if (data.value) {
      currentItem.value = data.value;
    }
    return { data, error };
  }

  async function createItem(dto: CreateMyFeatureDto) {
    const { data, error } = await useFetchApi('/api/v2/my-feature', {
      method: 'POST',
      body: dto,
    });
    if (data.value) {
      await fetchList();
    }
    return { data, error };
  }

  async function updateItem(dto: UpdateMyFeatureDto) {
    const { data, error } = await useFetchApi('/api/v2/my-feature/update', {
      method: 'POST',
      body: dto,
    });
    if (data.value) {
      await fetchList();
    }
    return { data, error };
  }

  async function deleteItem(id: number) {
    const { data, error } = await useFetchApi(`/api/v2/my-feature/${id}`, {
      method: 'DELETE',
    });
    if (data.value) {
      await fetchList();
    }
    return { data, error };
  }

  function resetState() {
    items.value = [];
    currentItem.value = null;
    totalCount.value = 0;
  }

  return {
    items,
    loading,
    totalCount,
    currentItem,
    fetchList,
    fetchOne,
    createItem,
    updateItem,
    deleteItem,
    resetState,
  };
});
```

---

---

## Portage Frontend — Using the Exit Prompt {#wiki-code-examples-portage-frontend-using-the-exit-prompt}

**Real pattern from `stores/ui/exitPrompt.ts` and `03-trip-create-exit-prompt.global.ts`:**

```typescript
// In a page component — wire up the dialog
<script setup lang="ts">
import { useExitPromptStore } from '~/stores/ui/exitPrompt';

const exitPromptStore = useExitPromptStore();
const { showDialog } = storeToRefs(exitPromptStore);

function onConfirmExit() {
  exitPromptStore.resolveDialog(true);
}
function onCancelExit() {
  exitPromptStore.resolveDialog(false);
}
</script>

<template>
  <!-- Your page content -->
  <DialogModal v-model:visible="showDialog">
    <template #header>Leave Page</template>
    <div><p>Are you sure you want to leave?</p></div>
    <template #footer>
      <ButtonSecondary class="mr-2" @click="onCancelExit()">Stay</ButtonSecondary>
      <ButtonPrimary @click="onConfirmExit()">Leave</ButtonPrimary>
    </template>
  </DialogModal>
</template>
```

```typescript
// In middleware — check for unsaved changes
export default defineNuxtRouteMiddleware(async (to, from) => {
  if (from.path.includes('my-feature/create') && to.path !== from.path) {
    const exitPromptStore = useExitPromptStore();
    const shouldExit = await exitPromptStore.showExitPrompt();
    if (!shouldExit) return navigateTo(from.path);
  }
});
```

---

---

## TravelTracker — Objection.js Model Pattern {#wiki-code-examples-traveltracker-objection-js-model-pattern}

**Real pattern from TravelTracker's models:**

```javascript
// app/model/my-feature.model.js
const { Model } = require('objection');
const AuditBaseModel = require('./audit-base.model');

class MyFeature extends AuditBaseModel {
  static get tableName() {
    return 'my_feature';
  }

  static get relationMappings() {
    const Related = require('./related.model');

    return {
      related: {
        relation: Model.HasManyRelation,
        modelClass: Related,
        join: {
          from: 'my_feature.id',
          to: 'related.my_feature_id',
        },
      },
    };
  }

  static get modifiers() {
    return {
      filterByStatus(query, status) {
        if (status) query.where('status', status);
      },
      withRelations(query) {
        query.withGraphFetched('[related]');
      },
    };
  }
}

module.exports = MyFeature;
```

---

---

## TravelTracker — Understanding the Module Pattern {#wiki-code-examples-traveltracker-understanding-the-module-pattern}

**Real pattern from TravelTracker's Express modules:**

```javascript
// app/my-feature/api.js
const { midware } = global;
const myFeatureService = require('./service');

module.exports = function (app) {
  app.get('/api/my-feature', midware('view|myfeature'), async (req, res, next) => {
    try {
      const result = await myFeatureService.list(req);
      req.response = result;
      next();
    } catch (err) {
      req.error = err;
      next();
    }
  });

  app.post('/api/my-feature', midware('add|myfeature'), async (req, res, next) => {
    try {
      const result = await myFeatureService.save(req);
      req.response = result;
      next();
    } catch (err) {
      req.error = err;
      next();
    }
  });
};
```

---

---

