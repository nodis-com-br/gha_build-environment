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

function verifyArtifactOnS3(bucket, key, envVars, projectSetup, skipVersionValidation) {
    const s3 = new AWS.S3({apiVersion: '2006-03-01'});
    let bucketParam = {Bucket: bucket, Key: key};
    s3.headObject(bucketParam, function(err) {
        skipVersionValidation || err || core.setFailed(config.versionConflictMessage);
        publishEnvVarsArtifact(envVars, projectSetup);
    });
}

function publishEnvVarsArtifact(envVars, projectSetup) {
    const artifactClient = artifact.create();
    'build_environment' in projectSetup && Object.assign(envVars, projectSetup['build_environment']);
    fs.writeFileSync('./environmentVars.json', JSON.stringify(envVars, null, 2));
    artifactClient
        .uploadArtifact('environmentVars', ['environmentVars.json'], '.')
        .catch(error => core.setFailed(error));
    core.info('Environment variables: ' + JSON.stringify(envVars, null, 4));
}


// Get project metadata from execution environment
const projectSetup = ini.parse(fs.readFileSync(process.env.GITHUB_WORKSPACE + '/setup.cfg', 'utf-8'));
const projectName = process.env.GITHUB_REPOSITORY.split('/')[1];
const projectVersion = projectSetup['bumpversion']['current_version'];
const projectBaseVersion = projectVersion.split('-')[0];
const targetBranch = process.env.GITHUB_EVENT_NAME === 'push' ? process.env.GITHUB_REF : 'refs/heads/' + process.env.GITHUB_BASE_REF;

const skipVersionValidation = process.env.SKIP_VERSION_VALIDATION === "true";

// Create environment vars object
let envVars = {
    NODIS_PROJECT_NAME: projectName,
    NODIS_PROJECT_VERSION: projectVersion,
    NODIS_PROJECT_BASE_VERSION: projectBaseVersion,
    NODIS_LEGACY: !!targetBranch.match(config.legacyPattern)
};

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

    if (workflow === 'gitflow') envVars.NODIS_DEPLOY_ENV = getDeploymentEnvironment(targetBranch, projectVersion);
    envVars.MAESTRO_REPOSITORY = 'maestro_' + team;

    switch(getClassGrouping(projectClass)) {

        case 'packages':

            if (interpreter === 'python') {

                let pypiHeaders = buildAuthHeader('NODIS_PYPI');
                let pypiUrl = 'https://' + process.env.NODIS_PYPI_HOST + '/simple/' + projectName + '/json';
                fetch(pypiUrl, {headers: pypiHeaders}).then(response => {

                    if (response.status === 200) return response.json();
                    else if (response.status === 404) return {releases: []};
                    else core.setFailed('Could not retrieve pypi package versions: ' + response.status + ' ' + response.statusText)

                }).then(response => {

                    targetBranch === 'refs/head/master' || skipVersionValidation || projectVersion in response['releases'] && core.setFailed(config['versionConflictMessage']);
                    publishEnvVarsArtifact(envVars, projectSetup)

                }).catch(error => core.setFailed(error))

            }

            break;

        case 'charts':

            envVars.NODIS_PROJECT_NAME = projectName.substring(6);

            let chartsHeaders = buildAuthHeader('NODIS_CHART_REPOSITORY');
            let chartsUrl = 'https://' + process.env.NODIS_CHART_REPOSITORY_HOST + '/api/charts/' + envVars.NODIS_PROJECT_NAME + '/' + projectVersion;
            fetch(chartsUrl, {headers: chartsHeaders , method: 'HEAD'}).then(response => {

                skipVersionValidation || response.status === 200 && core.setFailed(config.versionConflictMessage);
                publishEnvVarsArtifact(envVars, projectSetup)

            }).catch(error => core.setFailed(error));

            break;

        case 'lambda':

            const functionName = projectName.substring(3);

            envVars.NODIS_FUNCTION_NAME = functionName;
            envVars.NODIS_ARTIFACT_NAME = functionName + '.zip';
            envVars.NODIS_ARTIFACT_FULLNAME = functionName + '-' + projectVersion + '.zip';
            envVars.NODIS_ARTIFACT_PATH = functionName;
            envVars.NODIS_ARTIFACT_BUCKET = config.lambdaBucket + '-' + process.env.AWS_REGION;

            verifyArtifactOnS3(envVars.NODIS_ARTIFACT_BUCKET, envVars.NODIS_ARTIFACT_PATH + '/' + envVars.NODIS_ARTIFACT_FULLNAME, envVars, projectSetup, skipVersionValidation);

            break;

        case 'publicImages':

            const imageName = projectName.substring(3);

            fetch('https://' + config.publicRegistry + '/v2/' + imageName + '/manifests/' + projectVersion).then(response => {

                skipVersionValidation || response.status === 200 && core.setFailed(config.versionConflictMessage);

                envVars.DOCKER_IMAGE_NAME = config.publicRegistry + '/' + imageName;
                envVars.DOCKER_IMAGE_TAGS = 'latest ' + projectVersion;

                publishEnvVarsArtifact(envVars, projectSetup)

            }).catch(error => core.setFailed(error));

            break;

        case 'privateImages':

            envVars.NODIS_DEPLOY_ENV = getDeploymentEnvironment(targetBranch, projectVersion);

            let registryHeaders = buildAuthHeader('NODIS_REGISTRY');
            let registryUrl = 'https://' + process.env.NODIS_REGISTRY_HOST + '/v2/' + projectName + '/manifests/' + projectVersion;
            fetch(registryUrl, {headers: registryHeaders}).then(response => {

                skipVersionValidation || response.status === 200 && core.setFailed(config.versionConflictMessage);

                envVars.DOCKER_IMAGE_NAME = process.env.NODIS_REGISTRY_HOST + '/' + projectName;
                envVars.DOCKER_IMAGE_TAGS = [projectVersion].concat(envVars.NODIS_LEGACY ? ['legacy'] : ['latest', projectBaseVersion, envVars.NODIS_DEPLOY_ENV]).join(' ');

                publishEnvVarsArtifact(envVars, projectSetup)

            }).catch(error => core.setFailed(error));

            break;

        case 'webapps':

            envVars.NODIS_DEPLOY_ENV = getDeploymentEnvironment(targetBranch, projectVersion);
            envVars.NODIS_ARTIFACT_FILENAME = projectName + '-' + projectVersion + '.tgz';
            envVars.NODIS_ARTIFACT_BUCKET = config.webappsBucket;
            envVars.NODIS_SUBDOMAIN = JSON.parse(fs.readFileSync(process.env.GITHUB_WORKSPACE +  '/package.json', 'utf-8'))['subdomain'];

            verifyArtifactOnS3(config.webappsBucket, projectName + '/' + envVars.NODIS_ARTIFACT_FILENAME, envVars, projectSetup, skipVersionValidation);

            break;

        default:

            core.setFailed('Could not build environment variables for ' + projectClass + '/' + interpreter)

    }

}).catch(error => core.setFailed(error));