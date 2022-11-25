import {entityExporter} from "./entityExporter";
import {RedisOrmOperationError} from "./errors/RedisOrmOperationError";
import {RedisOrmSchemaError} from "./errors/RedisOrmSchemaError";
import {eventEmitters} from "./eventEmitters";
import {PerformanceHelper} from "./helpers/PerformanceHelper";
import {parser} from "./parser";
import {Query} from "./Query";
import {redisOrm} from "./redisOrm";
import {IArgvValues, IEvents, IIdType, IInstanceValues, IPerformanceResult, ISaveResult} from "./types";

export class BaseEntity {
    // region static methods

    public static async connect(table: string = "") {
        // validate the schema
        table = table || redisOrm.getDefaultTable(this);
        const tableName = redisOrm.getTablePrefix(this) + table;
        const schemaErrors = await redisOrm.compareSchemas(this, tableName);
        if (schemaErrors.length) {
            throw new RedisOrmSchemaError(`(${this.name}, ${tableName}) Mismatch with remote Schemas`, schemaErrors);
        }

        return await redisOrm.getRedis(this);
    }

    /** @internal */
    public static newFromStorageStrings<T extends typeof BaseEntity>(
        this: T, storageStrings: { [key: string]: string }): InstanceType<T> {
        const entity = this.create({});
        entity.assignStorageStrings(storageStrings);
        return entity;
    }

    public static query<T extends typeof BaseEntity>(this: T): Query<T> {
        return new Query(this);
    }

    public static async find<T extends typeof BaseEntity>(this: T, id: IIdType) {
        return await this.query().find(id);
    }

    public static async findMany<T extends typeof BaseEntity>(this: T, ids: IIdType[]) {
        return await this.query().findMany(ids);
    }

    public static create<T extends typeof BaseEntity>(this: T, values: IArgvValues<InstanceType<T>>): InstanceType<T> {
        return (new this() as InstanceType<T>).setValues(values);
    }

    public static async all<T extends typeof BaseEntity>(this: T) {
        return await this.query().run();
    }

    public static async count(): Promise<[number, IPerformanceResult]> {
        return await this.query().count();
    }

    // get the current redis instance, do not use internally
    public static async getRedis() {
        return await redisOrm.getRedis(this, false);
    }

    public static async resyncDb<T extends typeof BaseEntity>(this: T, table: string = ""): Promise<[boolean, IPerformanceResult]> {
        // get redis,
        table = table || redisOrm.getDefaultTable(this);
        const tableName = redisOrm.getTablePrefix(this) + table;
        const redis = await redisOrm.getRedis(this);
        const remoteSchemas = await redisOrm.getRemoteSchemas(this, tableName);

        // we resync only if we found any schema exist
        if (remoteSchemas) {
            // prepare arguments
            const keys: [] = [];
            const params = [
                redisOrm.getSchemasJson(this),
                tableName,
            ];

            // remove everything
            const performanceHelper = await redisOrm.getPerformanceHelper(this);
            const commandResult = await (redis as any).commandAtomicResyncDb(keys, params);
            const performanceResult =  await performanceHelper.getResult();

            const saveResult = JSON.parse(commandResult) as ISaveResult;

            if (saveResult.error) {
                throw new RedisOrmOperationError(`(${this.name}, ${tableName}) ${saveResult.error}`);
            }

            return [true, performanceResult];
        } else {
            return [false, PerformanceHelper.getEmptyResult()];
        }
    }

    public static async truncate(className: string, table: string = ""): Promise<[number, IPerformanceResult]> {
        if (className !== this.name) {
            throw new RedisOrmOperationError(`(${this.name}, ${table}) You need to provide the class name for truncate`);
        }

        // get redis,
        table = table || redisOrm.getDefaultTable(this);
        const tableName = redisOrm.getTablePrefix(this) + table;
        const redis = await redisOrm.getRedis(this);
        const remoteSchemas = await redisOrm.getRemoteSchemas(this, tableName);
        const performanceHelper = await redisOrm.getPerformanceHelper(this);

        // we truncate only if we found any schema exist
        let total = 0;
        if (remoteSchemas) {
            // prepare arguments
            const keys: [] = [];
            const params = [tableName];

            const commandResult = await (redis as any).commandAtomicTruncate(keys, params);
            const result = JSON.parse(commandResult);
            total = result.total;
        }

        const performanceResult =  await performanceHelper.getResult();
        return [total, performanceResult];
    }

    public static getEvents<T extends typeof BaseEntity>(this: T): IEvents<InstanceType<T>> {
        return eventEmitters.getEventEmitter(this);
    }

    public static getSchemas() {
        const entityColumns = redisOrm.getEntityColumns(this);
        const indexKeys = redisOrm.getIndexKeys(this);
        const uniqueKeys = redisOrm.getUniqueKeys(this);
        const primaryKey = redisOrm.getPrimaryKey(this);
        const autoIncrementKey = redisOrm.getAutoIncrementKey(this);
        const entityMeta = redisOrm.getEntityMeta(this);

        // convert to column objects
        const columnTypes: any = Object.keys(entityColumns)
            .reduce<object>((a, b) => Object.assign(a, {[b]: entityColumns[b].type}), {});

        return {
            columnTypes,
            indexKeys,
            uniqueKeys,
            primaryKey,
            autoIncrementKey,
            table: entityMeta.table,
            tablePrefix: entityMeta.tablePrefix,
            connection: entityMeta.connection,
        };
    }

    // endregion

    // region static method: import/export

    public static async export(file: string, table: string = "") {
        table = table || redisOrm.getDefaultTable(this);
        const [allEntities] = await this.query().setTable(table).run();
        await this.exportEntities(allEntities, file);
    }

    public static async exportEntities<T extends BaseEntity>(entities: T[], file: string) {
        await entityExporter.exportEntities(this, entities, file);
    }

    public static async import(file: string, skipSchemasCheck: boolean = false, table: string = "") {
        table = table || redisOrm.getDefaultTable(this);
        await entityExporter.import(this, file, skipSchemasCheck, table);
    }

    // endregion

    // region constructor / variables
    private _table: string = "";
    private _tableName: string = "";

    // flags
    private _isNew: boolean = true;

    // cache the column values
    private _values: { [key: string]: any } = {};

    // the actual storage value in redis
    private _storageStrings: { [key: string]: string } = {};

    // store the increment commands
    private _increments: { [key: string]: number } = {};

    constructor() {
        const now = new Date();
        this.createdAt = now;
        this.setTable(redisOrm.getDefaultTable(this.constructor));
    }

    // endregion

    // region public get properties: conditions

    public get isNew(): boolean {
        return this._isNew;
    }

    // endregion

    // region public properties

    public get createdAt(): Date {
        return this._get("createdAt");
    }

    public set createdAt(value: Date) {
        this._set("createdAt", value);
    }

    // endregion

    // region public methods

    public setTable(table: string) {
        this._table = table;
        this._tableName = redisOrm.getTablePrefix(this.constructor) +  table;
        return this;
    }

    public getTable() {
        return this._table;
    }

    public getEntityId(): string {
        const primaryKey = redisOrm.getPrimaryKey(this.constructor);
        const values: string[] = [];

        const value = this._get(primaryKey);
        if (typeof value === "number") {
            if (value && Number.isInteger(value)) {
                return value.toString();
            } else {
                throw new RedisOrmOperationError(`(${this.constructor.name}, ${this._tableName}) Invalid number value: ${value} for primary key: ${primaryKey}`);
            }

        } else if (typeof value === "string") {
            if (value) {
                return value;
            } else {
                throw new RedisOrmOperationError(`(${this.constructor.name}, ${this._tableName}) Invalid string value: '${value}' for primary key: ${primaryKey}`);
            }
        } else {
            throw new RedisOrmOperationError(`(${this.constructor.name}, ${this._tableName}) Invalid value: ${value} for primary key: ${primaryKey}`);
        }
    }

    public getValues<T extends BaseEntity>(this: T) {
        const values: any = {};
        const columns = redisOrm.getColumns(this.constructor);
        for (const column of columns) {
            values[column] = this._get(column);
        }

        return values as IInstanceValues<T>;
    }

    public increment<T extends BaseEntity>(this: T, column: keyof T, value: number = 1) {
        if (this.isNew) {
            throw new RedisOrmOperationError(`(${this.constructor.name}, ${this._tableName}) You cannot increment a new entity`);
        }

        if (redisOrm.isPrimaryKey(this.constructor, column as string)) {
            throw new RedisOrmOperationError(`(${this.constructor.name}, ${this._tableName}) You cannot increment primary key`);
        }

        if (redisOrm.isUniqueKey(this.constructor, column as string)) {
            throw new RedisOrmOperationError(`(${this.constructor.name}, ${this._tableName}) You cannot increment unique key`);
        }

        if (!redisOrm.isNumberColumn(this.constructor, column as string)) {
            throw new RedisOrmOperationError(`(${this.constructor.name}, ${this._tableName}) Column need to be in the type of Number`);
        }

        if (!Number.isInteger(value)) {
            throw new RedisOrmOperationError(`(${this.constructor.name}, ${this._tableName}) Increment value need to be an integer`);
        }

        this._increments[column as string] = value;
        return this;
    }

    public setValues<T extends BaseEntity>(this: T, values: IArgvValues<T>) {
        Object.assign(this, values);
        return this;
    }

    public async save() {
        return await this._saveInternal();
    }

    public async delete() {
        return await this._deleteInternal();
    }

    public clone(): this {
        const entity = new (this.constructor as any)() as this;
        entity.setValues(this.getValues());
        return entity;
    }

    public toJSON() {
        return this.getValues();
    }

    // endregion

    // region protected methods

    protected assignStorageStrings(storageStrings: { [key: string]: string }) {
        this._isNew = false;
        this._storageStrings = storageStrings;

        // we preserve default values by removing existing _values only
        for (const column of Object.keys(storageStrings)) {
            delete this._values[column];
        }
    }

    // endregion

    // region private methods: value get / set

    private _get(column: string): any {
        if (!(column in this._values)) {
            const entityColumns = redisOrm.getEntityColumn(this.constructor, column);
            this._values[column] = parser.parseStorageStringToValue(entityColumns.type, this._storageStrings[column]);
        }

        return this._values[column];
    }

    private _set(column: string, value: any, updateStorageString = false) {
        const entityColumns = redisOrm.getEntityColumn(this.constructor, column);
        const storageString = parser.parseValueToStorageString(entityColumns.type, value);
        this._values[column] = parser.parseStorageStringToValue(entityColumns.type, storageString);

        if (updateStorageString) {
            this._storageStrings[column] = storageString;
        }
    }

    // endregion

    // region private methods: common

    private async _saveInternal(): Promise<[this, IPerformanceResult]> {
        const changes = this._getChanges();
        if (Object.keys(changes).length === 0) {
            // no changes and no increments, no need to save
            if (Object.keys(this._increments).length === 0) {
                return [this, PerformanceHelper.getEmptyResult()];
            }
        }

        // prepare redis lua command parameters
        const indexKeys = redisOrm.getIndexKeys(this.constructor);
        const uniqueKeys = redisOrm.getUniqueKeys(this.constructor);
        const autoIncrementKey = redisOrm.getAutoIncrementKey(this.constructor);
        let entityId = "";

        // we must assign an entity id for the following case
        // - if it's not new
        // - if it's not auto increment
        // - if the auto increment key is not 0
        if (!this.isNew || !autoIncrementKey || changes[autoIncrementKey] !== "0") {
            entityId = this.getEntityId();
        }

        // prepare argument
        const params = [
            redisOrm.getSchemasJson(this.constructor),
            entityId,
            this.isNew,
            this._tableName,
            autoIncrementKey,
            JSON.stringify(indexKeys),
            JSON.stringify(uniqueKeys),
            JSON.stringify(changes),
            JSON.stringify(this._increments),
        ];

        const redis = await redisOrm.getRedis(this.constructor);
        const performanceHelper = await redisOrm.getPerformanceHelper(this.constructor);
        const commandResult =  await (redis as any).commandAtomicSave([], params);
        const saveResult = JSON.parse(commandResult) as ISaveResult;
        const performanceResult =  await performanceHelper.getResult();

        if (saveResult.error) {
            if (saveResult.error === "Mismatch with remote Schemas") {
                const schemaErrors = await redisOrm.compareSchemas(this.constructor, this._tableName);
                throw new RedisOrmSchemaError(`(${this.constructor.name}, ${this._tableName}) ${saveResult.error}`, schemaErrors);
            } else {
                throw new RedisOrmOperationError(`(${this.constructor.name}, ${this._tableName}) ${saveResult.error}`);
            }
        }

        // update storage strings
        Object.assign(this._storageStrings, changes);

        // if we do not have id and it's auto increment
        if (this.isNew && autoIncrementKey && saveResult.autoIncrementKeyValue) {
            this._set(autoIncrementKey, saveResult.autoIncrementKeyValue, true);
        }

        // if we have increment result
        if (saveResult.increments) {
            for (const [column, value] of Object.entries(saveResult.increments)) {
                this._set(column, value, true);
            }
        }

        // clean up
        this._increments = {};
        this._values = {};

        // update the flags
        const isNew = this._isNew;
        this._isNew = false;

        // fire event

        if (isNew) {
            eventEmitters.emit("create", this);
        } else {
            eventEmitters.emit("update", this);
        }

        return [this, performanceResult];
    }

    private async _deleteInternal(): Promise<[this, IPerformanceResult]> {
        // checking
        if (this.isNew) {
            throw new RedisOrmOperationError(`(${this.constructor.name}, ${this._tableName}) You cannot delete a new entity`);
        }

        // if it's soft delete
        const entityMeta = redisOrm.getEntityMeta(this.constructor);

        // prepare redis lua command parameters
        const entityId = this.getEntityId();
        const indexKeys = redisOrm.getIndexKeys(this.constructor);
        const uniqueKeys = redisOrm.getUniqueKeys(this.constructor);

        const keys: [] = [];
        const params = [
            redisOrm.getSchemasJson(this.constructor),
            entityId,
            this._tableName,
            JSON.stringify(indexKeys),
            JSON.stringify(uniqueKeys),
        ];

        const redis = await redisOrm.getRedis(this.constructor);
        const performanceHelper = await redisOrm.getPerformanceHelper(this.constructor);
        const commandResult =  await (redis as any).commandAtomicDelete(keys, params);
        const saveResult = JSON.parse(commandResult) as ISaveResult;
        const performanceResult =  await performanceHelper.getResult();

        // throw error if there is any
        if (saveResult.error) {
            if (saveResult.error === "Mismatch with remote Schemas") {
                const schemaErrors = await redisOrm.compareSchemas(this.constructor, this._tableName);
                throw new RedisOrmSchemaError(`(${this.constructor.name}, ${this._tableName}) ${saveResult.error}`, schemaErrors);
            } else {
                throw new RedisOrmOperationError(`(${this.constructor.name}, ${this._tableName}) ${saveResult.error}`);
            }
        }

        // fire event
        eventEmitters.emit("delete", this);

        return [this, performanceResult];
    }

    private _getChanges(): { [key: string]: string } {
        let hasChanges = false;
        const changes: { [key: string]: string } = {};
        const entityColumns = redisOrm.getEntityColumns(this.constructor);
        for (const [column, entityColumn] of Object.entries(entityColumns)) {
            // if no such value before, it must be a changes
            const currentValue = this._get(column);
            const storageString = parser.parseValueToStorageString(entityColumn.type, currentValue);
            if (!(column in this._storageStrings) || storageString !== this._storageStrings[column]) {
                changes[column] = storageString;
                hasChanges = true;
            }
        }

        return changes;
    }

    // endregion
}
