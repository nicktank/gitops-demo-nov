/* eslint-disable no-await-in-loop */

exports.name = 'REST';
exports.version = '0.1';
exports.disabled = false;
exports.destroyable = false;

const { Expression, NestedPropertyAccessor, PartialEvalRewrite } = C.expr;
const { clampStr } = C.util;
const { httpSearch, isHttp200, RestAuthType, RestVerb, HttpError, wrapExpr, PaginationType } = C.internal.HttpUtils;

let filter;
let batchSize;

// See HttpUtils.ISearchOptions
const authOpts = {};
const discoverOpts = {};
const collectOpts = {};
let earliest;
let latest;

const DISC_TYPE_NONE = 'none';
const DISC_TYPE_HTTP = 'http';
const DISC_TYPE_JSON = 'json';
const DISC_TYPE_LIST = 'list';

const AUTH_TYPES = [RestAuthType.NONE, RestAuthType.BASIC, RestAuthType.LOGIN];

function validateCollectOpts(opts, conf) {
  if (opts == null) {
    throw new Error('Invalid Argument, missing collect configuration');
  }
  if (opts.url == null) {
    throw new Error('Invalid argument, missing collect url');
  }
  if (opts.method == null || ![RestVerb.GET, RestVerb.POST].includes(opts.method)) {
    throw new Error(`Invalid argument, collect method ${opts.method} must be ${RestVerb.GET} or ${RestVerb.POST}`);
  }
  if (!opts.authType || !AUTH_TYPES.includes(opts.authType)) {
    throw new Error(`Invalid argument, opts.authType ${opts.authType} must be one of: ${AUTH_TYPES}`);
  }
  if (opts.authType === RestAuthType.BASIC && (opts.username == null || opts.password == null)) {
    throw new Error(`Invalid argument, username and password are required with ${RestAuthType.BASIC} authentication`);
  }
  if (conf.collectMethod === 'post_with_body' && !opts.postBody) {
    throw new Error('Invalid Argument: Collect postBody is required when Post with Body is specified!');
  }
  if (opts.pagination && !Object.values(PaginationType).includes(opts.pagination.type)) {
    throw new Error(`Invalid Argument: Unexpected pagination type: ${opts.pagination.type}`);
  }
  if (opts.pagination && (opts.pagination.type === PaginationType.RESP_BODY || opts.pagination.type === PaginationType.RESP_HEADER)) {
    if (opts.pagination.typeOpts == null || !opts.pagination.typeOpts.nextPageField)  {
      throw new Error(`Invalid Argument: pagination type: ${opts.pagination.type} missing required field pagination.typeOpts.nextPageField!`);
    }
    if (opts.pagination.typeOpts.maxPages == null) {
      throw new Error(`Invalid Argument: pagination type: ${opts.pagination.type} missing required field pagination.typeOpts.maxPages!`);
    }
  }
}

function parseResult(data, contentType, logger) {
  let result;
  if (contentType === 'application/json') {
    result = C.util.parse(data);
  } else if (contentType === 'application/xml') {
    result = C.Text.parseXml(data);
  } else {
    // Try to parse json
    result = C.util.parse(data);
    if (!result) {
      // Try to parse XML
      result = C.Text.parseXml(data);
    }
  }
  if (!result) {
    throw new Error(`Failed to parse discover result, unsupported content type: ${contentType}`);
  }
  return result;
}
async function getDataFromResult(result, dataField, logger) {
  // Result can be an object with readResult method or just an object with hard coded result data.
  const resultData = result.readResult ? await result.readResult() : result;
  const contentType = result && result.res && result.res.headers ? result.res.headers['content-type'] : '';
  logger.debug('Processing http discover response', { discoverDataField: dataField, statusCode: resultData.statusCode || '-1', contentType, elapsed: resultData.elapsed || -1, responseData: clampStr(resultData.data || '', 350) });
  const dataObj = parseResult(resultData.data, contentType, logger);
  const npa = dataField ? new NestedPropertyAccessor(dataField) : undefined;
  const extracted = npa ? npa.get(dataObj) : dataObj;
  logger.debug(`Extracted Result: ${clampStr(JSON.stringify(dataObj || ''), 350)}`, { dataField, extracted });
  return extracted;
}

function validateDiscoverOpts(opts,conf) {
  const discoverType = opts.type || undefined;
  if (discoverType === DISC_TYPE_NONE) {
    // Validation not required
  } else if (discoverType === DISC_TYPE_HTTP) {
    validateCollectOpts(opts, conf);
  } else if (discoverType === DISC_TYPE_JSON) {
    if (!opts.resultData) {
      throw new Error(`Invalid argument - resultData is required for discover type ${DISC_TYPE_JSON}`);
    }
  } else if (discoverType === DISC_TYPE_LIST) {
    if (!opts.resultData) {
      throw new Error(`Invalid argument, missing resultData for discover type: ${DISC_TYPE_LIST}`);
    }
    if (!opts.dataField) {
      throw new Error(`Invalid argument, missing dataField for discover type: ${DISC_TYPE_LIST}`);
    }
  } else {
    throw new Error(`Invalid discover type: ${discoverType}!`);
  }
  if (conf.discoverMethod === 'post_with_body' && !opts.postBody) {
    throw new Error('Invalid Argument: Collect postBody is required when Post with Body is specified!');
  }
}

function validateAuthOpts(opts) {
  if (opts.authType === RestAuthType.LOGIN) {
    const missing = ['username', 'password', 'url', 'method', 'postBody', 'dataField', 'tokenExpr'].filter(v => opts[v] == null);
    if (missing.length) throw new Error(`Missing required authentication attributes=${missing}`);
  } else if (opts.authTye === RestAuthType.BASIC) {
    ['username', 'password'].forEach(v => {
      if (opts[v] == null) {
        throw new Error(`Missing required authentication attribute: ${v}`);
      }
    });
  }
}

// Copy params from pIn to pOut and trim values.
function copyParams(pIn, pOut) {
  if (!pOut) return;
  pIn = pIn || [];
  pIn.forEach((h) => {
    const name = h.name ? h.name.trim() : undefined;
    const value = h.value ? h.value.trim() : undefined;
    if (name && value) pOut[name] = value;
  });
}

function getMethod(value) {
  const method = value || RestVerb.GET;
  // Allowed method values: 'get', 'post', or 'post_with_body'. Map the latter two options to 'post'.
  return method === RestVerb.GET ? method : RestVerb.POST;
}

exports.init = async (opts) => {
  const conf = opts.conf;
  filter = conf.filter || 'true';
  batchSize = conf.maxBatchSize || 10;
  earliest = conf.earliest;
  latest = conf.latest;

  // Authentication
  if (conf.authentication) {
    authOpts.authType = conf.authentication.replace('Secret', '');
  } else {
    authOpts.authType = RestAuthType.NONE;
  }
  authOpts.username = conf.username;
  authOpts.password = conf.password;
  authOpts.url = conf.loginUrl;
  authOpts.method = authOpts.authType === RestAuthType.LOGIN ? RestVerb.POST : undefined;
  authOpts.postBody = conf.loginBody;
  authOpts.dataField = conf.tokenRespAttribute;
  authOpts.tokenExpr = conf.authHeaderExpr;
  authOpts.timeout = (conf.timeout || 0) * 1000;
  authOpts.useRoundRobinDns = Boolean(conf.useRoundRobinDns);
  authOpts.stream = false;
  authOpts.name = 'Authenticate';
  validateAuthOpts(authOpts);
  // Discover
  const discoverConf = conf.discovery;
  discoverOpts.type = discoverConf.discoverType;
  if (discoverConf.type !== DISC_TYPE_NONE) {
    discoverOpts.authType = authOpts.authType;
    discoverOpts.url = discoverConf.discoverUrl;
    discoverOpts.method = getMethod(discoverConf.discoverMethod);
    discoverOpts.params = {};
    discoverOpts.headers = {};
    discoverOpts.dataField = discoverConf.discoverDataField;
    discoverOpts.postBody = discoverConf.discoverBody;
    // For Basic auth
    discoverOpts.username = conf.username;
    discoverOpts.password = conf.password;
    discoverOpts.timeout = (conf.timeout || 0) * 1000;
    discoverOpts.useRoundRobinDns = Boolean(conf.useRoundRobinDns);
    discoverOpts.name = 'Discover';
    discoverOpts.stream = false;
    if (discoverConf.discoverType === DISC_TYPE_JSON && discoverConf.manualDiscoverResult) {
      discoverOpts.resultData = discoverConf.manualDiscoverResult;
    } else if (discoverConf.discoverType === DISC_TYPE_LIST && discoverConf.itemList) {
      // Manually setup resultData and dataField to include list items as a JSON object
      discoverOpts.resultData = discoverConf.manualDiscoverResult;
      const discResults = { items: [] };
      discoverConf.itemList.forEach(v => discResults.items.push({ id: v }));
      discoverOpts.resultData = JSON.stringify(discResults);
      discoverOpts.dataField = 'items';
    }
    copyParams(discoverConf.discoverRequestParams, discoverOpts.params);
    copyParams(discoverConf.discoverRequestHeaders, discoverOpts.headers);
    discoverOpts.exprArgs = { earliest, latest };
    validateDiscoverOpts(discoverOpts,discoverConf);
  }
  // Collect
  if (conf.collectUrl) {
    collectOpts.authType = authOpts.authType;
    collectOpts.url = conf.collectUrl;
    collectOpts.method = getMethod(conf.collectMethod);
    collectOpts.params = {};
    collectOpts.headers = {};
    collectOpts.postBody = conf.collectBody;
    // For basic auth
    collectOpts.username = conf.username;
    collectOpts.password = conf.password;
    collectOpts.timeout = (conf.timeout || 0) * 1000;
    collectOpts.useRoundRobinDns = Boolean(conf.useRoundRobinDns);
    collectOpts.name = 'Collect';
    collectOpts.stream = true;
    copyParams(conf.collectRequestParams, collectOpts.params);
    copyParams(conf.collectRequestHeaders, collectOpts.headers);
    const paginationType = conf.pagination && conf.pagination.type ? conf.pagination.type : PaginationType.NONE;
    const typeOpts = {};
    if (paginationType === PaginationType.RESP_HEADER || paginationType === PaginationType.RESP_BODY) {
      typeOpts.nextPageField = conf.pagination.attribute;
      typeOpts.maxPages = conf.pagination.maxPages;
    } else if (paginationType === PaginationType.RESP_HEADER_LINK) {
      typeOpts.nextPageField = 'link'; // Spec
      typeOpts.nextRelationAttribute = conf.pagination.nextRelationAttribute; // multiple choices: next or next-archive
      typeOpts.curRelationAttribute = conf.pagination.curRelationAttribute; // multiple choices: self or current
      typeOpts.maxPages = conf.pagination.maxPages;
    }
    collectOpts.pagination = { type: paginationType, typeOpts };
  }
  validateCollectOpts(collectOpts, conf);
};

// Handle authentication steps and update internal config attributes with authentication results.
async function authenticate(opts, logger) {
  if (authOpts.authType !== RestAuthType.LOGIN) {
    return;
  }
  if (opts.bearerToken) {
    return;
  }
  // Make rest call to perform authentication
  try {
    authOpts.exprArgs = { ...authOpts }; // Arguments for params, headers, and post body expressions
    const token = await (await httpSearch(authOpts, logger)).extractResult(authOpts.dataField);
    if (!token) {
      throw new Error(`Login success but failed retrieve auth token field: ${authOpts.dataField}`);
    }
    // Add bearerToken to discover and collection options
    const bearerToken = new Expression(wrapExpr(authOpts.tokenExpr)).evalOn({ token });
    discoverOpts.bearerToken = bearerToken;
    collectOpts.bearerToken = bearerToken;
  } catch (error) {
    logger.error('Authentication error', { error });
    throw error;
  }
}

exports.discover = async (job) => {
  try {
    await authenticate({ ...discoverOpts, job }, job.logger());
    if (discoverOpts.type === DISC_TYPE_NONE) {
      // Discover URL not specified in config, this means the collect can run stand-alone
      // as a single task. Add faked discover record to kick off the collection process.
      await job.addResult({ fakeDiscover: true });
      return;
    }
    let result;
    if (discoverOpts.type === DISC_TYPE_JSON || discoverOpts.type === DISC_TYPE_LIST) {
      result = { data: discoverOpts.resultData, statusCode: 200, elapsed: 0 };
    } else {
      result = await httpSearch({...discoverOpts, job }, job.logger());
    }
    let data = await getDataFromResult(result, discoverOpts.dataField, job.logger());
    // Add results to job
    if (data && Array.isArray(data)) {
      const requiredFields = ['host', 'source'];
      if (discoverOpts.dataField) requiredFields.push(discoverOpts.dataField);
      const filterExpr = new Expression(filter, { disallowAssign: true,
        partialEval: new PartialEvalRewrite((field) => !requiredFields.includes(field))
      });
      const results = [];
      for (let record of data) {
        if (typeof record !== 'object') {
          record = { id: record };
        }
        if (!filterExpr.evalOn(record)) continue; // No filter match
        if (!record.source) record.source = discoverOpts.url;
        results.push(record);
        if (results.length >= batchSize) {
          await job.addResults(results);
          results.length = 0;
        }
      }
      if (results.length) await job.addResults(results);
    } else if (data) {
      if (typeof data !== 'object') {
        data = { id: data };
      }
      if (!data.source) data.source = discoverOpts.url;
      await job.addResult(data);
    }
  } catch (error) {
    job.logger().error('Discover error', { error });
    throw error;
  }
};
exports.collect = async (collectible, job) => {
  if (collectible.__pageNum == null) collectible.__pageNum = 1;
  try {
    await authenticate({ ...collectOpts, job } , job.logger());
    const opts = { ...collectOpts, job, exprArgs: { ...collectible, earliest, latest }, pagination: { ...collectOpts.pagination, job, collectible } };

    opts.url = collectible.urlOverride || opts.url;
    const result = await httpSearch(opts, job.logger());
    result.res.on('end', async() => {
      if (!isHttp200(result.res.statusCode)) {
        const error = new HttpError('http error', result.res.statusCode, { host: result.host, port: result.port, path: result.path, method: result.method });
        job.reportError(error).catch(() => {});
      }
    });
    result.res.on('error', (error) => {
      job.reportError(error).catch(() => {});
    });
    return result.res;
  } catch (error) {
    job.reportError(error).catch(() => {});
    throw error;
  }
};
