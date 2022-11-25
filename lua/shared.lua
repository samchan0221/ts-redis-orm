local function debugClear()
    redis.pcall("del", "debug")
end

local function debug(msg)
    redis.pcall("RPUSH", "debug", msg)
end

local function error(errorMessage)
    local respond = {}
    respond["error"] = errorMessage
    return cjson.encode(respond)
end

local function isempty(s)
    return s == nil or s == ""
end

local function isnotempty(s)
    return s ~= nil and s ~= ""
end

local function isint(s)
    return s ~= nil and s == math.floor(s)
end

local function isnumeric(s)
    local v = tonumber(s);
    return v ~= nil and tostring(v) ~= "nan"
end

local function getEntityStorageKey(tableName, id)
    return "entity:" .. tableName .. ":" .. id
end

local function getIndexStorageKey(tableName, column)
    return "index:" .. tableName .. ":" .. column
end

local function getUniqueStorageKey(tableName, column)
    return "unique:" .. tableName .. ":" .. column
end

local function getAutoIncrementStorageKey()
    return "meta:autoIncrement";
end

local function getSchemasStorageKey()
    return "meta:schemas";
end

local function getTempStorageKey(tableName, column)
    return "temp:" .. tableName .. ":" .. column
end

local function getRemoteSchemas(tableName)
    local hash = tableName;
    local schemasStorageKey = getSchemasStorageKey()
    local remoteSchemas = redis.call("HGET", schemasStorageKey, tableName)

    if remoteSchemas == false then
        return {}
    end

    return cjson.decode(remoteSchemas)
end

local function verifySchemas(tableName, clientSchemasString)
    local hash = tableName;
    local schemasStorageKey = getSchemasStorageKey()
    local remoteSchemas = redis.call("HGET", schemasStorageKey, hash)
    if remoteSchemas == false then
        redis.call("HSET", schemasStorageKey, tableName, clientSchemasString)
        return true
    end

    return remoteSchemas == clientSchemasString
end

local function table_check(indexArr)
    for i, val in pairs( indexArr ) do
        logit(tostring(i) .. ": (" .. type(val) .. ") " .. val)
    end
end

local function table_hasKey(dict, key)
    for _key, value in pairs(dict) do
        if _key == key then
            return true
        end
    end
    return false
end

local function table_hasValue(array, value)
    for i, _value in ipairs(array) do
        if _value == value then
            return true
        end
    end
    return false
end

local function table_slice(arr, first, last)
    local sliced = {}
    for i = first or 1, last or #arr, 1 do
        sliced[#sliced + 1] = arr[i]
    end
    return sliced
end

local function table_values( tbl )
    local arr = {}
    for key, val in pairs( tbl ) do
        arr[ #arr + 1 ] = val
    end
    return arr
end

local function table_flattern(dict)
    local tbl = {}
    for k, v in pairs(dict) do
        table.insert(tbl, k)
        table.insert(tbl, v)
    end
    return tbl
end

local function table_keys( tbl )
    local arr = {}
    for key, val in pairs( tbl ) do
        arr[ #arr + 1 ] = key
    end
    return arr
end

local function table_toTable(arr)
    local tbl = {}
    for i, val in ipairs(arr) do
        tbl[val] = 1
    end
    return tbl
end

local function table_whereIndexIntersect(indexArr, tbls)
    if #tbls < 1 then return indexArr end
    local tblParis = ipairs(tbls)
    for i, v in pairs(indexArr) do
        for ii, _ in ipairs(tbls) do
            if tbls[ii][v] == nil then
                indexArr[i] = nil
            end
        end
    end
    -- this indexArr will become non iterable table, convert it back to array
    return table_values(indexArr)
end

-- others
local formatFn = {
    ["%Y"] = function(self) return self["y"] end,
    ["%y"] = function(self) return string.format("%.2d", self["y"] % 100) end,
    ["%m"] = function(self) return string.format("%.2d", self["m"]) end,
    ["%d"] = function(self) return string.format("%.2d", self["d"]) end,
    ["%h"] = function(self) return string.format("%.2d", self["h"]) end,
    ["%i"] = function(self) return string.format("%.2d", self["i"]) end,
    ["%s"] = function(self) return string.format("%.2d", self["s"]) end
}

local function dateFormat(time, format)
    time = tonumber(time)
    if time ~= nil and time >= 0 then
        local dates = {}
        time = time / 1000
        dates["s"] = math.floor(time % 60)
        time = time / 60
        dates["i"] = math.floor(time % 60)
        time = time / 60
        dates["h"] = math.floor(time % 24)
        time = time / 24

        local a = math.floor((4 * time + 102032) / 146097 + 15)
        local b = math.floor(time + 2442113 + a - math.floor(a / 4))
        local c = math.floor((20 * b - 2442) / 7305)
        local d = math.floor(b - 365 * c - math.floor(c / 4))
        local e = math.floor(d * 1000 / 30601)
        local f = math.floor(d - e * 30 - math.floor(e * 601 / 1000))

        if e <= 13 then
            c = c - 4716
            e = e - 1
        else
            c = c - 4715
            e = e - 13
        end

        dates["y"] = c
        dates["m"] = e
        dates["d"] = f
        local result = string.gsub(format, "%%[%a%%\\b\\f]", function(x) local f = formatFn[x]; return (f and f(dates) or x) end)
        return result
    end
    return ""
end


