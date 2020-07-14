const core = require('@actions/core');
const github = require('@actions/github');
const artifact = require('@actions/artifact');
const ini = require('ini');
const fs = require('fs');
const fetch = require('node-fetch');
const base64 = require('base-64');
const AWS = require('aws-sdk');
const config = require('./config.js');


function validateTopics(topics, subset, title) {
    let matches = [];
    subset.forEach(value => topics.includes(value) && matches.push(value));
    if (matches.length === 0) core.setFailed('!!! Project missing ' + title + ' topic !!!');
    else if (matches.length > 1) core.setFailed('!!! Project cannot have multiple ' + title + ' topics !!!');
    else return matches[0]
}

function pubEnvArtifact(envVars) {

    const artifactClient = artifact.create();

    fs.writeFileSync('./environmentVars.json', JSON.stringify(envVars, null, 2));
    artifactClient
        .uploadArtifact('environmentVars', ['environmentVars.json'], '.')
        .catch(error => core.setFailed(error));

}

// Get project metadata from execution environment
const commitMessage = 'commits' in github.context.payload ? github.context.payload.commits[0].message : '';
const branchType =  process.env.GITHUB_EVENT_NAME === 'push' ? process.env.GITHUB_REF.split('/')[2] : false;
const projectName = process.env.GITHUB_REPOSITORY.split('/')[1];
const fullVersion = ini.parse(fs.readFileSync(process.env.GITHUB_WORKSPACE + '/setup.cfg', 'utf-8'))['bumpversion']['current_version'];
const skipVersionValidation = process.env.SKIP_VERSION_VALIDATION === "true";


// Create environment vars object
let envVars = {
    NODIS_PROJECT_NAME: projectName,
    NODIS_FULL_VERSION: fullVersion,
    NODIS_BASE_VERSION: fullVersion.split('-')[0],
    NODIS_NO_DEPLOY: commitMessage.includes('***NO_DEPLOY***') || branchType === 'legacy',
    NODIS_NO_BUILD: commitMessage.includes('***NO_BUILD***'),
    NODIS_LEGACY: branchType === 'legacy'
};

// Fetch project topic from GitHub
let headers = {Authorization: 'token ' + process.env.GITHUB_TOKEN, Accept: "application/vnd.github.mercy-preview+json"};
fetch(process.env.GITHUB_API_URL + '/repos/' + process.env.GITHUB_REPOSITORY + '/topics', {headers: headers}).then(response => {

    if (response.status === 200) return response.json();
    else throw 'Could not retrieve topics: ' + response.status + ' ' + response.statusText

}).then(response => {

    // Validate project topics
    const interpreter = validateTopics(response.names, config['interpreterTopics'], 'interpreter');
    const projectClass = validateTopics(response.names, config['projectClassTopics'], 'class');

    // Set deployment environment and validate source git branch
    if (branchType && projectClass !== 'library') {

        const buildPrefix = fullVersion.split('-')[1];

        envVars.NODIS_DEPLOY_ENV = buildPrefix === undefined ? 'prod' : config['envMappings'][buildPrefix.replace(/[0-9]/g, '')];
        envVars.NODIS_DEPLOY_ENV === undefined && core.setFailed('Environment is undefined: ' + fullVersion);

        if (!config['branchTypeMappings'][envVars.NODIS_DEPLOY_ENV].includes(branchType)) {
            core.setFailed('!!! Branch mismatch: version '+ fullVersion + ' should not be published on branch ' + branchType + ' !!!')
        }

    }

    // Set python library environment vars
    if (projectClass === 'library' && interpreter === 'python') {

        let headers = {Authorization: 'Basic '+ base64.encode(process.env.NODIS_PYPI_USER + ':' + process.env.NODIS_PYPI_PASSWORD)};
        fetch('https://' + process.env.NODIS_PYPI_HOST + '/simple/' + projectName + '/json', {headers: headers}).then(response => {

            if (response.status === 200) return response.json();
            else throw 'Could not retrieve pypi package versions: ' + response.status + ' ' + response.statusText

        }).then(response => {

            skipVersionValidation || fullVersion in response['releases'] && core.setFailed(config['versionConflictMessage']);
            pubEnvArtifact(envVars)

        }).catch(error => core.setFailed(error))

    // Set docker application environment vars
    } else if (config['dockerAppTopics'].includes(projectClass)) {

        let headers = {Authorization: 'Basic '+ base64.encode(process.env.NODIS_REGISTRY_USER + ':' + process.env.NODIS_REGISTRY_PASSWORD)};
        fetch('https://' + process.env.NODIS_REGISTRY_HOST + '/v2/' + projectName + '/manifests/' + fullVersion, {headers: headers}).then(response => {

            skipVersionValidation || response.status === 200 && core.setFailed(config['versionConflictMessage']);

            envVars.NODIS_SERVICE_TYPE = projectClass === 'cronjob' ? 'cronjob' : 'deployment';
            envVars.NODIS_CUSTOM_TAG = envVars.NODIS_LEGACY ? 'legacy' : 'latest';
            envVars.NODIS_IMAGE_NAME = process.env.NODIS_REGISTRY_HOST + '/' + projectName;
            envVars.NODIS_SERVICE_NAME = projectName.replace(/_/g, '-');
            envVars.NODIS_CLUSTER_NAME = JSON.parse(process.env.NODIS_CLUSTER_MAPPINGS)[envVars.NODIS_DEPLOY_ENV];

            pubEnvArtifact(envVars)

        }).catch(error => core.setFailed(error));

    // Set webapps environment vars
    } else if (config['webAppTopics'].includes(projectClass)) {

        const s3 = new AWS.S3({apiVersion: '2006-03-01'});

        envVars.NODIS_ARTIFACT_FILENAME = projectName + '-' + fullVersion + '.tgz';
        envVars.NODIS_SUBDOMAIN = JSON.parse(fs.readFileSync(process.env.GITHUB_WORKSPACE +  '/package.json', 'utf-8'))['subdomain'];

        let bucketParam = {Bucket: 'nodis-webapps', Key: projectName + '/' + envVars.NODIS_ARTIFACT_FILENAME};
        s3.headObject(bucketParam, function(err, data) {

            skipVersionValidation || err || core.setFailed(config['versionConflictMessage']);
            pubEnvArtifact(envVars);

        });

    }

}).catch(error => core.setFailed(error));