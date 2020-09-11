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


function getMetadataFromTopics(type, topics, pattern) {
    let matches = [];
    topics.forEach(topic => topic.match(pattern) && matches.push(topic));
    if (matches.length === 0) core.setFailed('Project missing ' + type + ' topic');
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

function getDeploymentEnvironment(targetBranch, fullVersion) {
    let env = false;
    for (let k in config.deployEnvs) if (config.deployEnvs.hasOwnProperty(k)) if (fullVersion.match(config.deployEnvs[k].versionPattern)) env = k;
    if (env) {
        if (targetBranch.match(config.deployEnvs[env].branchPattern)) return env;
        else core.setFailed(['Branch mismatch: version', fullVersion, 'should not be published on branch', targetBranch].join(' '))
    } else core.setFailed(['Deployment environment not found:', targetBranch, '/', fullVersion].join(' '));
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
const targetBranch = process.env.GITHUB_EVENT_NAME === 'push' ? process.env.GITHUB_REF : process.env.GITHUB_BASE_REF;

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
fetch(process.env.GITHUB_API_URL + '/repos/' + process.env.GITHUB_REPOSITORY + '/topics', {headers: headers}).then(response => {

    if (response.status === 200) return response.json();
    else throw ['Could not retrieve topics:', response.status, response.statusText].join(' ')

}).then(response => {

    // Validate project topics
    const team = getMetadataFromTopics('team', response.names, config.topics.teams);
    const interpreter = getMetadataFromTopics('interpreter', response.names, config.topics.interpreters);
    const projectClass = getMetadataFromTopics('class', response.names, aggregateClasses());

    switch(getClassGrouping(projectClass)) {

        case 'libraries':

            if (interpreter === 'python') {

                let headers = buildAuthHeader('NODIS_PYPI');
                fetch('https://' + process.env.NODIS_PYPI_HOST + '/simple/' + projectName + '/json', {headers: headers}).then(response => {

                    if (response.status === 200) return response.json();
                    else if (response.status === 404) return {releases: []};
                    else throw 'Could not retrieve pypi package versions: ' + response.status + ' ' + response.statusText

                }).then(response => {

                    targetBranch === 'refs/head/master' || skipVersionValidation || projectVersion in response['releases'] && core.setFailed(config['versionConflictMessage']);
                    publishEnvVarsArtifact(envVars, projectSetup)

                }).catch(error => core.setFailed(error))

            }

            break;

        case 'charts':

            envVars.NODIS_PROJECT_NAME = projectName.substring(7);

            let url1 = 'https://' + process.env.NODIS_CHART_REPOSITORY_HOST + '/api/charts/' + envVars.NODIS_PROJECT_NAME + '/' + projectVersion;
            fetch(url1, {headers: buildAuthHeader('NODIS_CHART_REPOSITORY'), method: 'HEAD'}).then(response => {

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

        case 'docker':

            const imageName = projectName.substring(3);

            fetch('https://' + config.publicRegistry + '/v2/' + imageName + '/manifests/' + projectVersion).then(response => {

                skipVersionValidation || response.status === 200 && core.setFailed(config.versionConflictMessage);

                envVars.DOCKER_IMAGE_NAME = config.publicRegistry + '/' + imageName;
                envVars.DOCKER_IMAGE_TAGS = 'latest ' + projectVersion;

                publishEnvVarsArtifact(envVars, projectSetup)

            }).catch(error => core.setFailed(error));

            break;

        case 'workloads':

            envVars.NODIS_DEPLOY_ENV = getDeploymentEnvironment(targetBranch, projectVersion);

            let url2 = 'https://' + process.env.NODIS_REGISTRY_HOST + '/v2/' + projectName + '/manifests/' + projectVersion;
            fetch(url2, {headers: buildAuthHeader('NODIS_REGISTRY')}).then(response => {

                skipVersionValidation || response.status === 200 && core.setFailed(config.versionConflictMessage);

                envVars.MAESTRO_REPOSITORY = 'maestro_' + team;

                envVars.DOCKER_IMAGE_NAME = process.env.NODIS_REGISTRY_HOST + '/' + projectName;
                envVars.DOCKER_IMAGE_TAGS = [projectVersion].concat(envVars.NODIS_LEGACY ? ['legacy'] : ['latest', projectBaseVersion, envVars.NODIS_DEPLOY_ENV]).join(' ');

                envVars.DEPLOY_RC_TO_PROD = projectClass !== 'deployment';

                publishEnvVarsArtifact(envVars, projectSetup)

            }).catch(error => core.setFailed(error));

            break;

        case 'webapps':

            envVars.NODIS_DEPLOY_ENV = getDeploymentEnvironment(targetBranch, projectVersion);

            envVars.NODIS_ARTIFACT_FILENAME = projectName + '-' + projectVersion + '.tgz';
            envVars.NODIS_SUBDOMAIN = JSON.parse(fs.readFileSync(process.env.GITHUB_WORKSPACE +  '/package.json', 'utf-8'))['subdomain'];

            verifyArtifactOnS3(config.webappsBucket, projectName + '/' + envVars.NODIS_ARTIFACT_FILENAME, envVars, projectSetup, skipVersionValidation);

            break;

        default:

            core.setFailed('Could not build environment variables for ' + projectClass + '/' + interpreter)

    }

}).catch(error => core.setFailed(error));