require('dotenv').config();
const core = require('@actions/core');
const artifact = require('@actions/artifact');
const ini = require('ini');
const fs = require('fs');
const fetch = require('node-fetch');
const base64 = require('base-64');
const AWS = require('aws-sdk');
const config = require('./config.js');
const process = require('process');


function getMetadataFromTopics(type, topics, pattern, required) {
    let matches = [];
    topics.forEach(topic => topic.match(pattern) && matches.push(topic));
    if (matches.length === 0) required && core.setFailed('Project missing ' + type + ' topic');
    else if (matches.length === 1) {
        core.info('Project ' + type + ': ' + matches[0]);
        return matches[0]
    } else core.setFailed('Project cannot have multiple ' + type + ' topics');
}

function aggregateClasses() {
    let classArray = [];
    for (let k in config.topics.classes) if (config.topics.classes.hasOwnProperty(k)) classArray = classArray.concat(config.topics.classes[k]);
    return new RegExp('(' + classArray.join('|') + ')')
}

function getDeploymentEnvironment(targetBranch, projectVersion) {
    let env = false;
    for (let k in config.deployEnvs) if (config.deployEnvs.hasOwnProperty(k)) if (projectVersion.match(config.deployEnvs[k].versionPattern)) env = k;
    if (env) {
        if (targetBranch.match(config.deployEnvs[env].branchPattern)) return env;
        else core.setFailed(['Branch mismatch: version', projectVersion, 'should not be published on branch', targetBranch].join(' '))
    } else core.setFailed(['Deployment environment not found:', targetBranch, '/', projectVersion].join(' '));
}

function getClassGrouping(projectClass) {
    for (let k in config.topics.classes) if (config.topics.classes.hasOwnProperty(k)) {
        if (config.topics.classes[k].includes(projectClass)) return k
    }
}

function buildAuthHeader(envPrefix) {
    return {Authorization: 'Basic ' + base64.encode(process.env[envPrefix + '_USER'] + ':' + process.env[envPrefix + '_PASSWORD'])};
}

function verifyArtifactOnS3(bucket, key, vars, projectSetup, skipVersionValidation) {
    const s3 = new AWS.S3({apiVersion: '2006-03-01'});
    let bucketParam = {Bucket: bucket, Key: key};
    s3.headObject(bucketParam, function(err) {
        skipVersionValidation || err || core.setFailed(config.versionConflictMessage);
        publishVarsArtifact(vars);
    });
}

function publishVarsArtifact(vars) {
    const artifactClient = artifact.create();
    fs.writeFileSync('./environmentVars.json', JSON.stringify(vars, null, 2));
    artifactClient
        .uploadArtifact('environmentVars', ['environmentVars.json'], '.')
        .catch(error => core.setFailed(error));
    core.info('Environment variables: ' + JSON.stringify(vars, null, 4));
}


// Get project metadata from execution environment
const projectSetup = ini.parse(fs.readFileSync(process.env.GITHUB_WORKSPACE + '/setup.cfg', 'utf-8'));
const projectVersion = projectSetup['bumpversion']['current_version'];
const projectBaseVersion = projectVersion.split('-')[0];
const targetBranch = process.env.GITHUB_EVENT_NAME === 'push' ? process.env.GITHUB_REF : 'refs/heads/' + process.env.GITHUB_BASE_REF;

const skipVersionValidation = process.env.SKIP_VERSION_VALIDATION === "true" || projectSetup['build_environment']['SKIP_VERSION_VALIDATION'] === "true";

// Create environment vars object
let vars = {
    NODIS_PROJECT_NAME: process.env.GITHUB_REPOSITORY.split('/')[1],
    NODIS_PROJECT_VERSION: projectVersion,
    NODIS_PROJECT_BASE_VERSION: projectBaseVersion,
    NODIS_LEGACY: !!targetBranch.match(config.legacyPattern)
};

'build_environment' in projectSetup && Object.assign(vars, projectSetup['build_environment']);

// Fetch project topic from GitHub
let headers = {Authorization: 'token ' + process.env.GITHUB_TOKEN, Accept: "application/vnd.github.mercy-preview+json"};
let url = process.env.GITHUB_API_URL + '/repos/' + process.env.GITHUB_REPOSITORY + '/topics';
fetch(url, {headers: headers}).then(response => {

    if (response.status === 200) return response.json();
    else throw ['Could not retrieve topics:', response.status, response.statusText].join(' ')

}).then(response => {

    // Validate project topics
    const team = getMetadataFromTopics('team', response.names, config.topics.teams);
    const interpreter = getMetadataFromTopics('interpreter', response.names, config.topics.interpreters);
    const projectClass = getMetadataFromTopics('class', response.names, aggregateClasses());
    const workflow = getMetadataFromTopics('workflow', response.names, config.topics.workflows, false);

    if (workflow === 'gitflow') vars.NODIS_DEPLOY_ENV = getDeploymentEnvironment(targetBranch, projectVersion);
    vars.MAESTRO_REPOSITORY = 'maestro_' + team;

    switch(getClassGrouping(projectClass)) {

        case 'packages':

            if (interpreter === 'python') {

                let pypiHeaders = buildAuthHeader('NODIS_PYPI');
                let pypiUrl = 'https://' + process.env.NODIS_PYPI_HOST + '/simple/' + vars.NODIS_PROJECT_NAME + '/json';
                fetch(pypiUrl, {headers: pypiHeaders}).then(response => {

                    if (response.status === 200) return response.json();
                    else if (response.status === 404) return {releases: []};
                    else core.setFailed('Could not retrieve pypi package versions: ' + response.status + ' ' + response.statusText)

                }).then(response => {

                    targetBranch === 'refs/head/master' || skipVersionValidation || projectVersion in response['releases'] && core.setFailed(config['versionConflictMessage']);
                    publishVarsArtifact(vars)

                }).catch(error => core.setFailed(error))

            }

            break;

        case 'charts':

            vars.NODIS_PROJECT_NAME = vars.NODIS_PROJECT_NAME.substring(6);

            let chartsHeaders = buildAuthHeader('NODIS_CHART_REPOSITORY');
            let chartsUrl = 'https://' + process.env.NODIS_CHART_REPOSITORY_HOST + '/api/charts/' + vars.NODIS_PROJECT_NAME + '/' + projectVersion;
            fetch(chartsUrl, {headers: chartsHeaders , method: 'HEAD'}).then(response => {

                skipVersionValidation || response.status === 200 && core.setFailed(config.versionConflictMessage);
                publishVarsArtifact(vars)

            }).catch(error => core.setFailed(error));

            break;

        case 'lambda':

            const functionName = vars.NODIS_PROJECT_NAME.substring(3);

            vars.NODIS_FUNCTION_NAME = functionName;
            vars.NODIS_ARTIFACT_NAME = functionName + '.zip';
            vars.NODIS_ARTIFACT_FULLNAME = functionName + '-' + projectVersion + '.zip';
            vars.NODIS_ARTIFACT_PATH = functionName;
            vars.NODIS_ARTIFACT_BUCKET = config.lambdaBucketPrefix + '-' + process.env.AWS_REGION;

            verifyArtifactOnS3(vars.NODIS_ARTIFACT_BUCKET, vars.NODIS_ARTIFACT_PATH + '/' + vars.NODIS_ARTIFACT_FULLNAME, vars, projectSetup, skipVersionValidation);

            break;

        case 'publicImages':

            const imageName = vars.NODIS_PROJECT_NAME.substring(3);

            fetch('https://' + config.publicRegistry + '/v2/' + imageName + '/manifests/' + projectVersion).then(response => {

                skipVersionValidation || response.status === 200 && core.setFailed(config.versionConflictMessage);

                vars.DOCKER_IMAGE_NAME = config.publicRegistry + '/' + imageName;
                vars.DOCKER_IMAGE_TAGS = 'latest ' + projectVersion;

                publishVarsArtifact(vars)

            }).catch(error => core.setFailed(error));

            break;

        case 'privateImages':

            vars.NODIS_DEPLOY_ENV = getDeploymentEnvironment(targetBranch, projectVersion);

            let registryHeaders = buildAuthHeader('NODIS_REGISTRY');
            let registryUrl = 'https://' + process.env.NODIS_REGISTRY_HOST + '/v2/' + vars.NODIS_PROJECT_NAME + '/manifests/' + projectVersion;
            fetch(registryUrl, {headers: registryHeaders}).then(response => {

                skipVersionValidation || response.status === 200 && core.setFailed(config.versionConflictMessage);

                vars.DOCKER_IMAGE_NAME = process.env.NODIS_REGISTRY_HOST + '/' + vars.NODIS_PROJECT_NAME;
                vars.DOCKER_IMAGE_TAGS = [projectVersion].concat(vars.NODIS_LEGACY ? ['legacy'] : ['latest', projectBaseVersion, vars.NODIS_DEPLOY_ENV]).join(' ');

                publishVarsArtifact(vars)

            }).catch(error => core.setFailed(error));

            break;

        case 'webapps':

            vars.NODIS_DEPLOY_ENV = getDeploymentEnvironment(targetBranch, projectVersion);
            vars.NODIS_ARTIFACT_FILENAME = vars.NODIS_PROJECT_NAME + '-' + projectVersion + '.tgz';
            vars.NODIS_ARTIFACT_BUCKET = config.webappsArtifactBucket;
            vars.NODIS_WEBAPP_BUCKET = config.webappBucketPrefix + '-' + vars.NODIS_PROJECT_NAME;
            vars.NODIS_SUBDOMAIN = JSON.parse(fs.readFileSync(process.env.GITHUB_WORKSPACE +  '/package.json', 'utf-8'))['subdomain'];

            verifyArtifactOnS3(config.webappsArtifactBucket, vars.NODIS_PROJECT_NAME + '/' + vars.NODIS_ARTIFACT_FILENAME, vars, projectSetup, skipVersionValidation);

            break;

        default:

            core.setFailed('Could not build environment variables for ' + projectClass + '/' + interpreter)

    }

}).catch(error => core.setFailed(error));