module.exports = {
    versionConflictMessage: "Version already exists in repository",
    publicRegistry: 'docker.io/nodisbr',
    webappsBucket: 'nodis-webapps',
    lambdaBucket: 'nodis-lambda',
    legacyPattern: /^refs\/head\/legacy\/.+$/,
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
            branchPattern: /^refs\/head\/(develop|legacy\/.+)$/,
        },
        qa: {
            versionPattern: /^\d+\.\d+\.\d+-rc\d+$/,
            branchPattern: /^refs\/head\/release\/.+$/,
        },
        prod: {
            versionPattern: /^\d+\.\d+\.\d+$/,
            branchPattern: /^refs\/head\/(master|hotfix\/.+)$/,
        }
    },
};
