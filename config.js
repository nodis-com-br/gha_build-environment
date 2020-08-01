module.exports = {
    versionConflictMessage: "!!! Version already exists in repository !!!",
    publicRegistry: 'docker.io/nodisbr',
    webappsBucket: 'nodis-webapps',
    lambdaBucket: 'nodis-lambda',
    interpreterTopics: [
        "python",
        "nodejs",
        "shell",
        "docker"
    ],
    projectClassTopics: [
        "flask-app",
        "django-app",
        "react-app",
        "nodejs-app",
        "cronjob",
        "library",
        "public-image",
        "lambda-function"

    ],
    dockerAppTopics: [
        "flask-app",
        "nodejs-app",
        "django-app",
        "cronjob",
    ],
    webAppTopics: [
        "react-app"
    ],
    envMappings: {
        dev: "dev",
        rc: "qa"
    },
    branchTypeMappings: {
        dev: [
            "develop",
            "legacy"
        ],
        qa: [
            "release",
        ],
        prod: [
            "master",
            "hotfix",
        ]
    }
};
