import {entityExporter} from "./entityExporter";
import {RedisOrmEntityError} from "./errors/RedisOrmEntityError";
import {RedisOrmSchemaError} from "./errors/RedisOrmSchemaError";
import {metaInstance} from "./metaInstance";
import {parser} from "./parser";
import {Query} from "./Query";
import {IArgValues, IIdObject, IInstanceValues, ISaveResult} from "./types";

export class BaseEntity {
    // region static methods

    public static async connect() {
        // this will init connection
        return await metaInstance.getRedis(this);
    }

    public static newFromStorageStrings<T extends typeof BaseEntity>(
        this: T, storageStrings: { [key: string]: string }): InstanceType<T> {
        const entity = this.create({});
        entity.assignStorageStrings(storageStrings);
        return entity;
    }

    public static query<T extends typeof BaseEntity>(this: T): Query<T> {
        return new Query(this);
    }

    public static async find<T extends typeof BaseEntity>(this: T, id: IIdObject<InstanceType<T>>):
        Promise<InstanceType<T> | undefined> {
        return await this.query().find(id);
    }

    public static async findMany<T extends typeof BaseEntity>(this: T, idObjects: Array<IIdObject<InstanceType<T>>>):
        Promise<Array<InstanceType<T>>> {
        return await this.query().findMany(idObjects);
    }

    public static create<T extends typeof BaseEntity>(this: T, values: IArgValues<InstanceType<T>>): InstanceType<T> {
        return (new this() as InstanceType<T>).set(values);
    }

    public static async all<T extends typeof BaseEntity>(this: T): Promise<Array<InstanceType<T>>> {
        return await this.query().get();
    }

    public static async count(): Promise<number> {
        return await this.query().count();
    }

    // get the current redis instance, do not use internally
    public static async getRedis() {
        return await metaInstance.getRedis(this, false);
    }

    public static async resyncDb<T extends typeof BaseEntity>(this: T) {
        // get redis,
        const redis = await metaInstance.getRedis(this);
        const remoteSchemas = await metaInstance.getRemoteSchemas(this, redis);

        // we resync only if we found any schema exist
        if (remoteSchemas) {
            // prepare arguments
            const tableName = metaInstance.getTable(this);
            const keys: [] = [];
            const params = [
                metaInstance.getSchemasJson(this),
                tableName,
            ];

            // remove everything
            const commandResult = await (redis as any).commandAtomicResyncDb(keys, params);
            const saveResult = JSON.parse(commandResult) as ISaveResult;

            if (saveResult.error) {
                throw new RedisOrmEntityError(saveResult.error);
            }
        }
    }

    public static async truncate(className: string) {
        if (className !== this.name) {
            throw new RedisOrmEntityError("You need to provide the class name for truncate");
        }

        // get redis,
        const redis = await metaInstance.getRedis(this);
        const remoteSchemas = await metaInstance.getRemoteSchemas(this, redis);

        // we truncate only if we found any schema exist
        if (remoteSchemas) {
            // prepare arguments
            const tableName = metaInstance.getTable(this);
            const keys: [] = [];
            const params = [
                tableName,
            ];

            // remove everything
            await (redis as any).commandAtomicTruncate(keys, params);
        }
    }

    // endregion

    // region static method: import/export

    public static async export(file: string) {
        const all = await this.all();
        const allDeleted = await this.query().onlyDeleted().get();
        await this.exportEntities([...all, ...allDeleted], file);
    }

    public static async exportEntities<T extends BaseEntity>(entities: T[], file: string) {
        await entityExporter.exportEntities(this, entities, file);
    }

    public static getImportFileMeta() {
        //
    }

    public static async import(file: string) {
        await entityExporter.import(this, file);
    }

    // endregion

    // region constructor / variables

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
        this.updatedAt = now;
    }

    // endregion

    // region public get properties: conditions

    public get isDeleted(): boolean {
        return !isNaN(Number(this._storageStrings.deletedAt));
    }

    public get isNew(): boolean {
        return this._isNew;
    }

    // endregion

    // region public properties: createdAt, updatedAt, deletedAt

    public get createdAt(): Date {
        return this._get("createdAt");
    }

    public set createdAt(value: Date) {
        this._set("createdAt", value);
    }

    public get updatedAt(): Date {
        return this._get("updatedAt");
    }

    public set updatedAt(value: Date) {
        this._set("updatedAt", value);
    }

    public get deletedAt(): Date {
        return this._get("deletedAt");
    }

    public set deletedAt(value: Date) {
        this._set("deletedAt", value);
    }

    // endregion

    // region public methods

    public getEntityId(): string {
        const primaryKeys = metaInstance.getPrimaryKeys(this.constructor).sort();
        const values: string[] = [];

        for (const column of primaryKeys) {
            const value = this._get(column);
            if (typeof value === "number") {
                if (value && Number.isInteger(value)) {
                    values.push(value.toString().replace(/:/g, ""));
                } else {
                    throw new RedisOrmEntityError(`Invalid number value: ${value} for primary key: ${column}`);
                }

            } else if (typeof value === "string") {
                if (value) {
                    values.push(value.replace(/:/g, ""));
                } else {
                    throw new RedisOrmEntityError(`Invalid string value: '${value}' for primary key: ${column}`);
                }
            } else {
                throw new RedisOrmEntityError(`Invalid value: ${value} for primary key: ${column}`);
            }
        }

        return values.join(":");
    }

    public getValues<T extends BaseEntity>(this: T) {
        const values: any = {};
        const columns = metaInstance.getColumns(this.constructor);
        for (const column of columns) {
            values[column] = this._get(column);
        }

        return values as IInstanceValues<T>;
    }

    public increment<T extends BaseEntity>(this: T, column: keyof T, value: number = 1) {
        if (this.isNew) {
            throw new RedisOrmEntityError("You cannot increment a new entity");
        }

        if (metaInstance.isPrimaryKey(this.constructor, column as string)) {
            throw new RedisOrmEntityError("You cannot increment primary key");
        }

        if (metaInstance.isUniqueKey(this.constructor, column as string)) {
            throw new RedisOrmEntityError("You cannot increment unique key");
        }

        if (!metaInstance.isNumberColumn(this.constructor, column as string)) {
            throw new RedisOrmEntityError("Column need to be in the type of Number");
        }

        if (!Number.isInteger(value)) {
            throw new RedisOrmEntityError("Increment value need to be an integer");
        }

        this._increments[column as string] = value;
        return this;
    }

    public set<T extends BaseEntity>(this: T, values: IArgValues<T>) {
        Object.assign(this, values);
        return this;
    }

    public async save() {
        await this._saveInternal();
    }

    public async delete() {
        await this._deleteInternal({forceDelete: false});
    }

    public async forceDelete() {
        await this._deleteInternal({forceDelete: true});
    }

    public async restore() {
        await this._saveInternal({isRestore: true});
    }

    public clone(): this {
        const entity = new (this.constructor as any)() as this;
        entity.set(this.getValues());
        return entity;
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
            const schema = metaInstance.getSchema(this.constructor, column);
            this._values[column] = parser.parseStorageStringToValue(schema.type, this._storageStrings[column]);
        }

        return this._values[column];
    }

    private _set(column: string, value: any, updateStorageString = false) {
        const schema = metaInstance.getSchema(this.constructor, column);
        const storageString = parser.parseValueToStorageString(schema.type, value);
        this._values[column] = parser.parseStorageStringToValue(schema.type, storageString);

        if (updateStorageString) {
            this._storageStrings[column] = storageString;
        }
    }

    // endregion

    // region private methods: common

    private async _saveInternal({isRestore = false} = {}) {
        if (this.isDeleted && !isRestore) {
            throw new RedisOrmEntityError("You cannot update a deleted entity");
        }

        const changes = this._getChanges();
        if (Object.keys(changes).length === 0) {
            // no changes and no increments, no need to save
            if (!isRestore && Object.keys(this._increments).length === 0) {
                return;
            }
        }

        // update updatedAt if user didn't update it explicitly
        if (!changes.updatedAt) {
            changes.updatedAt = parser.parseValueToStorageString(Date, new Date());
        }

        // remove deletedAt for all situation
        changes.deletedAt = parser.parseValueToStorageString(Date, new Date(Number.NaN));

        // prepare redis lua command parameters
        const tableName = metaInstance.getTable(this.constructor);
        const indexKeys = metaInstance.getIndexKeys(this.constructor);
        const uniqueKeys = metaInstance.getUniqueKeys(this.constructor);
        const autoIncrementKey = metaInstance.getAutoIncrementKey(this.constructor);
        let entityId = "";

        // we must for a new entity for the case
        // - if it's not new
        // - if it's not auto increment
        // - if the auto increment key is not 0
        if (!this.isNew || !autoIncrementKey || changes[autoIncrementKey] !== "0") {
            entityId = this.getEntityId();
        }

        // prepare argument
        const params = [
            metaInstance.getSchemasJson(this.constructor),
            entityId,
            this.isNew,
            tableName,
            autoIncrementKey,
            JSON.stringify(indexKeys),
            JSON.stringify(uniqueKeys),
            JSON.stringify(changes),
            JSON.stringify(this._increments),
            isRestore,
        ];

        const redis = await metaInstance.getRedis(this.constructor);
        const commandResult =  await (redis as any).commandAtomicSave([], params);
        const saveResult = JSON.parse(commandResult) as ISaveResult;

        if (saveResult.error) {
            if (saveResult.error === "Invalid Schemas") {
                const schemaErrors = await metaInstance.compareSchemas(this.constructor);
                throw new RedisOrmSchemaError(saveResult.error, schemaErrors);
            } else {
                throw new RedisOrmEntityError(saveResult.error);
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
        this._isNew = false;
    }

    private async _deleteInternal({forceDelete = false} = {}) {
        // checking
        if (this.isNew) {
            throw new RedisOrmEntityError("You cannot delete a new entity");
        }

        // if it's soft delete
        const entityMeta = metaInstance.getEntityMeta(this.constructor);
        if (!forceDelete && this.isDeleted) {
            throw new RedisOrmEntityError("You cannot delete a deleted entity");
        }

        // if we didn't set deletedAt, set a new one
        let deletedAt = this.deletedAt;
        if (isNaN(deletedAt.getTime())) {
            deletedAt = new Date();
        }

        // prepare redis lua command parameters
        const entityId = this.getEntityId();
        const tableName = metaInstance.getTable(this.constructor);
        const indexKeys = metaInstance.getIndexKeys(this.constructor);
        const uniqueKeys = metaInstance.getUniqueKeys(this.constructor);

        const keys: [] = [];
        const params = [
            entityId,
            !forceDelete,
            tableName,
            deletedAt.getTime(),
            JSON.stringify(indexKeys),
            JSON.stringify(uniqueKeys),
        ];

        const redis = await metaInstance.getRedis(this.constructor);
        const commandResult =  await (redis as any).commandAtomicDelete(keys, params);
        const saveResult = JSON.parse(commandResult) as ISaveResult;

        // throw error if there is any
        if (saveResult.error) {
            throw new Error(saveResult.error);
        }

        // update deleted At
        this._set("deletedAt", deletedAt, true);
    }

    private _getChanges(): { [key: string]: string } {
        let hasChanges = false;
        const changes: { [key: string]: string } = {};
        const schemas = metaInstance.getSchemas(this.constructor);
        for (const [column, schema] of Object.entries(schemas)) {
            // if no such value before, it must be a changes
            const currentValue = this._get(column);
            const storageString = parser.parseValueToStorageString(schema.type, currentValue);
            if (!(column in this._storageStrings) || storageString !== this._storageStrings[column]) {
                changes[column] = storageString;
                hasChanges = true;
            }
        }

        return changes;
    }

    // endregion
}
