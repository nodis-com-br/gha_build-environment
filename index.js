const core = require('@actions/core');
const github = require('@actions/github');
const artifact = require('@actions/artifact');
const ini = require('ini');
const fs = require('fs');
const fetch = require('node-fetch');
const base64 = require('base-64');
const AWS = require('aws-sdk');



function validateTopics(topics, subset, title) {
    let matches = [];
    subset.forEach(value => topics.includes(value) && matches.push(value));
    if (matches.length === 0) core.setFailed('!!! Project missing ' + title + ' topic !!!');
    else if (matches.length > 1) core.setFailed('!!! Project cannot have multiple ' + title + ' topics !!!');
    else return matches[0]
}

function publishEnvironmentArtifact(environmentVars) {

    fs.writeFileSync('./environmentVars.json', JSON.stringify(environmentVars, null, 2));
        const artifactClient = artifact.create();

    artifactClient
        .uploadArtifact('environmentVars', ['environmentVars.json'], '.')
        .catch(error => core.setFailed(error));

}

const repositoryName = github.context.payload.repository.full_name;
const projectName = github.context.payload.repository.name;
const branchType = github.context.payload.ref.split('/')[3];
const commitMessage = github.context.payload.commits[0].message;

const projectPath = process.env.GITHUB_WORKSPACE + '/' + projectName;
const settings = JSON.parse(fs.readFileSync('./settings.json', 'utf-8'));
const fullVersion = ini.parse(fs.readFileSync(projectPath + '/setup.cfg', 'utf-8'))['bumpversion']['current_version'];
const baseVersion = fullVersion.split('-')[0];

let environmentVars = {
    PROJECT_NAME: projectName,
    FULL_VERSION: fullVersion,
    BASE_VERSION: baseVersion,
    NO_DEPLOY: commitMessage.includes('***NO_DEPLOY***') || branchType === 'legacy',
    NO_BUILD: commitMessage.includes('***NO_BUILD***'),
    LEGACY: branchType === 'legacy'
};

let headers = {Authorization: 'token ' + process.env.GITHUB_TOKEN, Accept: "application/vnd.github.mercy-preview+json"};
fetch('https://api.github.com/repos/' + repositoryName + '/topics', {headers: headers}).then(response => {

    if (response.status === 200) return response.json();
    else throw 'Could not retrieve topics: ' + response.status + ' ' + response.statusText

}).then(response => {

    const topics = response.names;
    const interpreter = validateTopics(topics, settings['interpreterTopics'], 'interpreter');
    const projectClass = validateTopics(topics, settings['projectClassTopics'], 'class');

    if (projectClass !== 'library') {

        const buildPrefix = fullVersion.split('-')[1];
        environmentVars.ENVIRONMENT = buildPrefix === undefined ? 'prod' : settings['envMappings'][buildPrefix.replace(/[0-9]/g, '')];
        environmentVars.ENVIRONMENT === undefined && core.setFailed('Environment is undefined: ' + fullVersion);

        if (!settings['branchTypeMappings'][environmentVars.ENVIRONMENT].includes(branchType)) {
            core.setFailed('!!! Branch mismatch: version '+ fullVersion + ' should not be published on branch ' + branchType + ' !!!')
        }

    }

    if (projectClass === 'library' && interpreter === 'python') {

        let headers = {Authorization: 'Basic '+ base64.encode(process.env.NODIS_PYPI_USER + ':' + process.env.NODIS_PYPI_PASSWORD)};
        fetch(process.env.NODIS_PYPI_URL + '/' + projectName + '/json', {headers: headers}).then(response => {

            if (response.status === 200) return response.json();
            else throw 'Could not retrieve pypi package versions: ' + response.status + ' ' + response.statusText

        }).then(response => {

            if (fullVersion in response.releases) core.setFailed(settings['versionConflictMessage']);
            else publishEnvironmentArtifact(environmentVars)

        })

    } else if (settings['dockerAppTopics'].includes(projectClass)) {

        let headers = {Authorization: 'Basic '+ base64.encode(process.env.NODIS_REGISTRY_USER + ':' + process.env.NODIS_REGISTRY_PASSWORD)};
        fetch('https://' + process.env.NODIS_REGISTRY + '/v2/' + projectName + '/manifests/' + fullVersion, {headers: headers}).then(response => {

            response.status === 200 && core.setFailed(settings['versionConflictMessage']);

            environmentVars.SERVICE_TYPE = projectClass === 'cronjob' ? 'cronjob' : 'deployment';
            environmentVars.CUSTOM_TAG = environmentVars.LEGACY ? 'legacy' : 'latest';
            environmentVars.IMAGE_NAME = process.env.NODIS_REGISTRY + '/' + projectName;
            environmentVars.SERVICE_NAME = projectName.replace('_', '-');
            environmentVars.CLUSTER_NAME = settings['clusterMappings'][environmentVars.ENVIRONMENT];

            publishEnvironmentArtifact(environmentVars)

        });

    } else if (settings['webAppTopics'].includes(projectClass)) {

        environmentVars.ARTIFACT_FILENAME = projectName + '-' + fullVersion + '.tgz';
        environmentVars.SUBDOMAIN = JSON.parse(fs.readFileSync(projectPath +  '/package.json', 'utf-8')).subdomain;

        const s3 = new AWS.S3({apiVersion: '2006-03-01'});

        let bucketParam = {Bucket: 'nodis-webapps', Key: projectName + '/' + environmentVars.ARTIFACT_FILENAME};
        s3.headObject(bucketParam, function(err, data) {

            if (err) publishEnvironmentArtifact(environmentVars);
            else core.setFailed(settings['versionConflictMessage'])

        });

    }

}).catch(error => {

    core.setFailed(error)

});