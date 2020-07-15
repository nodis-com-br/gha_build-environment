module.exports = {
    versionConflictMessage: "!!! Version already exists in repository !!!",
    publicRegistry: 'docker.io/nodisbr',
    interpreterTopics: [
        "python",
        "nodejs",
        "shell"
    ],
    projectClassTopics: [
        "flask-app",
        "react-app",
        "nodejs-app",
        "cronjob",
        "library",
        "public-image"
    ],
    dockerAppTopics: [
        "flask-app",
        "nodejs-app",
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
            "legacy"
        ],
        prod: [
            "master",
            "hotfix",
            "legacy"
        ]
    }
};