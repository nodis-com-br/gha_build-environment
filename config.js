module.exports = {
    versionConflictMessage: "!!! Version already exists in repository !!!",
    interpreterTopics: [
        "python",
        "nodejs"
    ],
    projectClassTopics: [
        "flask-app",
        "react-app",
        "nodejs-app",
        "cronjob",
        "library"
    ],
    dockerAppTopics: [
        "flask-app",
        "nodejs-app",
        "cronjob"
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