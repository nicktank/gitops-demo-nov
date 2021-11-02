exports.jobType = 'task-per-node';
exports.name = 'worker_upgrade';
let upgradeClient;
let packageVersion;
let localHashUrl;
let localPackageUrl;
let authToken;

const {
  internal: { UpgradeClient, performPackageDownload },
} = C;

exports.initJob = async (opts) => {
  const { conf } = opts.conf.executor;

  const { packageFile, packageUrl, hashUrl, hashFile, version, hashType } = conf.packageDownloadInfo;
  await performPackageDownload(packageUrl, packageFile, hashUrl, hashFile, hashType);

  packageVersion = version;
  localPackageUrl = conf.localPackageUrl;
  localHashUrl = conf.localHashUrl;
  authToken = conf.authToken;
};
exports.jobSeedTask = async () => {
  return {
    task: {
      packageVersion,
      packageUrl: localPackageUrl,
      hashUrl: localHashUrl,
      authToken,
    },
  };
};
exports.initTask = async (opts) => {
  upgradeClient = new UpgradeClient();
};

exports.jobOnError = async (job, taskId, error) => {}; 

exports.taskExecute = async (job, opts) => {

  const logger = job.logger();
  const descriptor = {
    packageUrl: opts.packageUrl,
    hashUrl: opts.hashUrl,
    version: opts.packageVersion,
  };
  logger.info('task opts', { opts });
  logger.info('Checking upgradability', { ...descriptor });
  let upgradeResult;
  upgradeResult = await upgradeClient.checkUpgradePath(descriptor, job.logger());
  if (!upgradeResult.canUpgrade) {
    logger.info(upgradeResult.message);
    job.addResult(upgradeResult);
    return;
  }
  logger.info('Fetching assets');
  const downloadResult = await upgradeClient.downloadAssets(descriptor, opts.authToken);
  logger.info('Fetched assets', downloadResult);
  if (opts.hashUrl) {
    logger.info('Verifying assets');
    await upgradeClient.verifyAssets(downloadResult);
    logger.info('Assets verified');
  }
  logger.info('Proceeding to installation');
  upgradeResult = await upgradeClient.installPackage(downloadResult, upgradeResult);
  logger.info(upgradeResult.message);
  if (!upgradeResult.isSuccess) {
    job.reportError(new Error(upgradeResult.message), 'TASK_FATAL');
    return;
  }
  await job.addResult(upgradeResult);
  setImmediate(() => upgradeClient.restartServer().catch(() => {}));
};
