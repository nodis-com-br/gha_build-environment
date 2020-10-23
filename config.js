module.exports = {
    versionConflictMessage: "Version already exists in repository",
    publicRegistry: 'docker.io/nodisbr',
    webappsArtifactBucket: 'nodis-webapps',
    webappBucketPrefix: 'nodis-web',
    lambdaBucketPrefix: 'nodis-lambda',
    legacyPattern: /^refs\/heads\/legacy\/.+$/,
    topics: {
        teams: /^(devback|devfront|catalog|experimento|devops)$/,
        interpreters: /^(python|nodejs|shell|docker|helm)$/,
        workflows: /^(gitflow)$/,
        classes: {
            packages: ["library", "python-app"],
            publicImages: ["public-image"],
            privateImages: ["flask-app", "nodejs-app", "django-app", "cronjob"],
            webapps: ["react-app"],
            charts: ["helm-chart"],
            lambda: ["lambda-function"]
        }
    },
    deployEnvs: {
        dev: {
            versionPattern: /^\d+\.\d+\.\d+-dev\d+$/,
            branchPattern: /^refs\/heads\/(develop|legacy\/.+)$/,
        },
        qa: {
            versionPattern: /^\d+\.\d+\.\d+-rc\d+$/,
            branchPattern: /^refs\/heads\/release\/.+$/,
        },
        prod: {
            versionPattern: /^\d+\.\d+\.\d+$/,
            branchPattern: /^refs\/heads\/(master|hotfix\/.+)$/,
        }
    }
};
