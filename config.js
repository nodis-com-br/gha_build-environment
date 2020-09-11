module.exports = {
    versionConflictMessage: "Version already exists in repository",
    publicRegistry: 'docker.io/nodisbr',
    webappsBucket: 'nodis-webapps',
    lambdaBucket: 'nodis-lambda',
    legacyPattern: /^refs\/heads\/legacy\/.+$/,
    topics: {
        teams: /(devback|devfront|catalog|experimento)/,
        interpreters: /(python|nodejs|shell|docker|helm)/,
        classes: {
            libraries: ["library"],
            workloads: ["flask-app", "nodejs-app", "django-app", "cronjob"],
            webapps: ["react-app"],
            charts: ["helm-charts"],
            docker: ["public-image"],
            lambda: ["lambda-function"]
        },
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
    },
};
