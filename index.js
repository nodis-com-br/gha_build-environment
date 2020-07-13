const core = require('@actions/core');
const github = require('@actions/github');
const artifact = require('@actions/artifact');
const ini = require('ini');
const fs = require('fs');
const fetch = require('node-fetch');
const base64 = require('base-64');
const AWS = require('aws-sdk');


const settings = {
    "versionConflictMessage": "!!! Version already exists in repository !!!",
    "interpreterTopics": [
        "python",
        "nodejs"
    ],
    "projectClassTopics": [
        "flask-app",
        "react-app",
        "nodejs-app",
        "cronjob",
        "library"
    ],
    "dockerAppTopics": [
        "flask-app",
        "nodejs-app",
        "cronjob"
    ],
    "webAppTopics": [
        "react-app"
    ],
    "envMappings": {
        "dev": "dev",
        "rc": "qa"
    },
    "branchTypeMappings": {
        "dev": [
            "develop",
            "legacy"
        ],
        "qa": [
            "release",
            "legacy"
        ],
        "prod": [
            "master",
            "hotfix",
            "legacy"
        ]
    }
};

function validateTopics(topics, subset, title) {
    let matches = [];
    subset.forEach(value => topics.includes(value) && matches.push(value));
    if (matches.length === 0) core.setFailed('!!! Project missing ' + title + ' topic !!!');
    else if (matches.length > 1) core.setFailed('!!! Project cannot have multiple ' + title + ' topics !!!');
    else return matches[0]
}

function publishEnvironmentArtifact(environmentVars) {

    const artifactClient = artifact.create();

    fs.writeFileSync('./environmentVars.json', JSON.stringify(environmentVars, null, 2));
    artifactClient
        .uploadArtifact('environmentVars', ['environmentVars.json'], '.')
        .catch(error => core.setFailed(error));

}

const commitMessage = github.context.payload.commits[0].message;

const projectName = process.env.GITHUB_REPOSITORY.split('/')[1];
const branchType =  process.env.GITHUB_EVENT_TYPE === 'push' ? process.env.GITHUB_REF.split('/')[2] : false;
const fullVersion = ini.parse(fs.readFileSync(process.env.GITHUB_WORKSPACE + '/setup.cfg', 'utf-8'))['bumpversion']['current_version'];

let environmentVars = {
    NODIS_PROJECT_NAME: projectName,
    NODIS_FULL_VERSION: fullVersion,
    NODIS_BASE_VERSION: fullVersion.split('-')[0],
    NODIS_NO_DEPLOY: commitMessage.includes('***NO_DEPLOY***') || branchType === 'legacy',
    NODIS_NO_BUILD: commitMessage.includes('***NO_BUILD***'),
    NODIS_LEGACY: branchType === 'legacy'
};

let headers = {Authorization: 'token ' + process.env.GITHUB_TOKEN, Accept: "application/vnd.github.mercy-preview+json"};
fetch(process.env.GITHUB_API_URL + '/repos/' + process.env.GITHUB_REPOSITORY + '/topics', {headers: headers}).then(response => {

    if (response.status === 200) return response.json();
    else throw 'Could not retrieve topics: ' + response.status + ' ' + response.statusText

}).then(response => {

    const interpreter = validateTopics(response.names, settings['interpreterTopics'], 'interpreter');
    const projectClass = validateTopics(response.names, settings['projectClassTopics'], 'class');

    if (branchType && projectClass !== 'library') {

        const buildPrefix = fullVersion.split('-')[1];
        environmentVars.NODIS_ENVIRONMENT = buildPrefix === undefined ? 'prod' : settings['envMappings'][buildPrefix.replace(/[0-9]/g, '')];
        environmentVars.NODIS_ENVIRONMENT === undefined && core.setFailed('Environment is undefined: ' + fullVersion);

        if (!settings['branchTypeMappings'][environmentVars.NODIS_ENVIRONMENT].includes(branchType)) {
            core.setFailed('!!! Branch mismatch: version '+ fullVersion + ' should not be published on branch ' + branchType + ' !!!')
        }

    }

    if (projectClass === 'library' && interpreter === 'python') {

        let headers = {Authorization: 'Basic '+ base64.encode(process.env.NODIS_PYPI_USER + ':' + process.env.NODIS_PYPI_PASSWORD)};
        fetch('https://' + process.env.NODIS_PYPI_HOST + '/simple/' + projectName + '/json', {headers: headers}).then(response => {

            if (response.status === 200) return response.json();
            else throw 'Could not retrieve pypi package versions: ' + response.status + ' ' + response.statusText

        }).then(response => {

            if (fullVersion in response.releases) core.setFailed(settings['versionConflictMessage']);
            else publishEnvironmentArtifact(environmentVars)

        }).catch(error => core.setFailed(error))

    } else if (settings['dockerAppTopics'].includes(projectClass)) {

        let headers = {Authorization: 'Basic '+ base64.encode(process.env.NODIS_REGISTRY_USER + ':' + process.env.NODIS_REGISTRY_PASSWORD)};
        fetch('https://' + process.env.NODIS_REGISTRY_HOST + '/v2/' + projectName + '/manifests/' + fullVersion, {headers: headers}).then(response => {

            response.status === 200 && core.setFailed(settings['versionConflictMessage']);

            environmentVars.NODIS_SERVICE_TYPE = projectClass === 'cronjob' ? 'cronjob' : 'deployment';
            environmentVars.NODIS_CUSTOM_TAG = environmentVars.LEGACY ? 'legacy' : 'latest';
            environmentVars.NODIS_IMAGE_NAME = process.env.NODIS_REGISTRY_HOST + '/' + projectName;
            environmentVars.NODIS_SERVICE_NAME = projectName.replace('_', '-');
            environmentVars.NODIS_CLUSTER_NAME = JSON.parse(process.env.NODIS_CLUSTER_MAPPINGS)[environmentVars.NODIS_ENVIRONMENT];

            publishEnvironmentArtifact(environmentVars)

        }).catch(error => core.setFailed(error));

    } else if (settings['webAppTopics'].includes(projectClass)) {

        const s3 = new AWS.S3({apiVersion: '2006-03-01'});

        environmentVars.NODIS_ARTIFACT_FILENAME = projectName + '-' + fullVersion + '.tgz';
        environmentVars.NODIS_SUBDOMAIN = JSON.parse(fs.readFileSync(process.env.GITHUB_WORKSPACE +  '/package.json', 'utf-8'))['subdomain'];

        let bucketParam = {Bucket: 'nodis-webapps', Key: projectName + '/' + environmentVars.NODIS_ARTIFACT_FILENAME};
        s3.headObject(bucketParam, function(err, data) {

            if (err) publishEnvironmentArtifact(environmentVars);
            else core.setFailed(settings['versionConflictMessage'])

        });

    }

}).catch(error => core.setFailed(error));