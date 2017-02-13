/* eslint-disable no-console, prefer-template */

const figures = require('figures');
const Git = require('nodegit');
const http = require('http');
const https = require('https');
const input = require('input');
const minimist = require('minimist');
const ora = require('ora');
const parseGitHubURL = require('parse-github-url');
const path = require('path');
const s3 = require('s3');
const { cyan, green, red, yellow } = require('chalk');

process.on('unhandledRejection', (error) => {
  console.error('Unhandled rejection', error && error.stack);
  process.exit(1);
});

(async () => {
  const argv = minimist(process.argv.slice(2), {
    default: { confirm: false },
  });

  const projectRoot = __dirname;
  // const localDir = path.resolve(projectRoot, 'art-of-fashion');
  const oneYear = 31556926;
  const oneMinute = 60;

  // increase socket pool size to improve bandwidth usage
  http.globalAgent.maxSockets = 20;
  https.globalAgent.maxSockets = 20;

  async function getParentDirs(repo, branch = 'master') {
    try {
      const commit = (await repo.getBranchCommit(branch));
      const diffs = await commit.getDiff();
      return diffs.reduce(async (col, diff) => {
        try {
          const patches = await diff.patches();
          return col.concat(patches.map(p => path.resolve(__dirname, path.dirname(p.newFile().path()).split('/').shift())));
        } catch (e) {
          console.error(e);
          return col;
        }
      }, []);
    } catch (e) {
      console.error(e);
      return [];
    }
  }

  // gather some facts from git
  const { branchName, githubRepo, directories } = await (async () => {
    try {
      const repository = await Git.Repository.open(projectRoot);
      const branch = (await repository.head()).shorthand();
      const dirs = await getParentDirs(repository, branch);
      const origin = await repository.getRemote('origin');
      const originURL = origin.url();

      const { repo, host } = parseGitHubURL(originURL);

      if (host !== 'github.com') {
        throw new Error(`Expected git remote "origin" to be a github.com URL, but it was: ${origin}`);
      }

      return {
        branchName: branch,
        githubRepo: repo,
        directories: dirs,
      };
    } catch (e) {
      console.error(e);
      return false;
    }
  })();

  const isProd = (branchName === 'master');

  // decide where to upload to
  const bucketName = isProd ? process.env.BUCKET_NAME_PROD : process.env.BUCKET_NAME_DEV;
  const remotePrefix = isProd ? `v1/${githubRepo}/` : `v1/${githubRepo}/${branchName}/`;

  // tell user what we're going to sync
  console.log(
    cyan('\nTo sync:\n') +
    // `  Local directory: ${yellow(path.relative(process.cwd(), localDir))}\n` +
    `  S3 Bucket: ${yellow(bucketName)}\n` +
    `  Remote prefix: ${yellow(remotePrefix)}\n` +
    `  Directories: ${yellow(directories.join('\n' + Array(15).join(' ')))}`);

  // ensure needed env vars are set; give friendly explanation if not
  {
    const expectedEnvVars = [
      'BUCKET_NAME', 'AWS_KEY', 'AWS_SECRET', 'AWS_SECRET',
    ].map(name => `${name}_${isProd ? 'PROD' : 'DEV'}`);

    if (!expectedEnvVars.every(name => process.env[name])) {
      console.error(red(
        'Cannot continue without the following environment variables:\n  ' +
        expectedEnvVars.join('\n  ')));
      process.exit(1);
    }
  }

  // establish upload parameters
  const params = {
    // localDir, // We're uploading multiple dirs possibly
    // deleteRemoved: true, // best not to use this in most cases

    // general params
    s3Params: {
      Bucket: bucketName,
      Prefix: remotePrefix,
      ACL: 'public-read',

      // you can include here any other options supported by putObject,
      // except Body and ContentLength
      // - see http://docs.aws.amazon.com/AWSJavaScriptSDK/latest/AWS/S3.html#putObject-property
    },

    // per-file params
    getS3Params: (localFile, stat, callback) => {
      const fileParams = {};

      const ext = path.extname(localFile);

      // use text/html for extensionless files (similar to gh-pages)
      if (ext === '') {
        fileParams.ContentType = 'text/html';
      }

      // set cache headers
      {
        const ttl = oneMinute;
        fileParams.CacheControl = `max-age=${ttl}`;
      }

      callback(null, fileParams);
    },
  };


  // await confirmation
  if (argv.confirm || await input.confirm('Continue?', { default: false })) {
    const spinner = ora({
      text: 'Deploying...',
      color: 'cyan',
    }).start();

    // make an S3 client instance
    const client = s3.createClient({
      s3Options: {
        accessKeyId: isProd ? process.env.AWS_KEY_PROD : process.env.AWS_KEY_DEV,
        secretAccessKey: isProd ? process.env.AWS_SECRET_PROD : process.env.AWS_SECRET_DEV,
        region: 'eu-west-1',
      },
    });

    function uploadDir(dir, p) {
      return new Promise((res, rej) => {
        p.localDir = dir;
        if (path.basename(dir) !== path.basename(__dirname) {
          p.s3Params.Prefix += path.basename(dir);    
        }

        const uploader = client.uploadDir(p);

        uploader.on('error', (error) => {
          console.error(`${red(figures.tick)} Failed to upload.`);
          console.error(error.stack);
          process.exit(1);
        });

        uploader.on('end', () => {
          console.log(`${green(figures.tick)} Deployed.`);

          // NB. this is the only one of about 5 different S3 URL formats that supports
          // automatic index.html resolution
          console.log(cyan(`\n  http://${bucketName}.s3-website-eu-west-1.amazonaws.com/${remotePrefix}`));
          res();
        });
      });
    }

    directories.sort().filter((item, pos, ary) => !pos || item !== ary[pos - 1])
    .reduce(async (col, curr) => {
      try {
        const results = await col;
        results.push(await uploadDir(curr, params));
        return results;
      } catch (e) {
        console.error(e);
        return col;
      }
    }, Promise.resolve([])).then(() => {
      spinner.stop();
    });
  }
})();
