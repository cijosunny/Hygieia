(function () {
    'use strict';

    angular
        .module(HygieiaConfig.module)
        .controller('productViewController', productViewController);

    productViewController.$inject = ['$scope', '$modal', 'pipelineData', '$location', 'collectorData', 'dashboardData', '$q', 'codeAnalysisData', 'buildData', 'testSuiteData'];
    function productViewController($scope, $modal, pipelineData, $location, collectorData, dashboardData, $q, codeAnalysisData, buildData, testSuiteData) {
        /*jshint validthis:true */
        var ctrl = this;

        // private properties
        var teamDashboardDetails = {},
            teamSummaryMetrics = {},
            latestBuilds = {};


        // public properties
        ctrl.stages = ['Commit', 'Build', 'Dev', 'QA', 'Int', 'Perf', 'Prod'];

        // public methods
        ctrl.load = load;
        ctrl.editTeam = editTeam;
        ctrl.addTeam = addTeam;
        ctrl.getSummaryMetric = getSummaryMetric;
        ctrl.openDashboard = openDashboard;
        ctrl.viewTeamStageDetails = viewTeamStageDetails;
        ctrl.teamStageHasCommits = teamStageHasCommits;
        ctrl.getLatestBuildInfo = getLatestBuildInfo;

        function setTeamSummaryMetric(collectorItemId, field, data) {
            if(!teamSummaryMetrics[collectorItemId]) {
                teamSummaryMetrics[collectorItemId] = {
                    codeCoverage: {
                        number: 0,
                        trendUp: false,
                        successState: false
                    },
                    functionalTestsPassed: {
                        number: 0,
                        trendUp: true,
                        successState: false
                    },
                    codeIssues: {
                        number: 0,
                        trendUp: true,
                        successState: false
                    }
                };
            }

            var obj = teamSummaryMetrics[collectorItemId],
                subFields = field.split('.');

            if(subFields.length == 1) {
                obj[field] = data;
            }
            else if (subFields.length == 2) {
                obj[subFields[0]][subFields[1]] = data;
            }
        }

        function openDashboard(item) {
            var dashboardDetails = teamDashboardDetails[item.collectorItemId];
            if(dashboardDetails) {
                $location.path('/dashboard/' + dashboardDetails.id);
            }
        }

        function load() {
            var options = $scope.widgetConfig.options;

            if (options && options.teams) {
                ctrl.configuredTeams = options.teams;
            }

            getTeamStageData(options.teams, [].concat(ctrl.stages));

            var requestedData = getTeamDashboardDetails(options.teams);
            if(!requestedData) {
                for(var collectorItemId in teamDashboardDetails) {
                    getTeamComponentData(collectorItemId);
                }
            }
        }

        function getTeamDashboardDetails(teams) {
            var update = false;
            _(teams).forEach(function(team) {
                if(!teamDashboardDetails[team.collectorItemId]) {
                    update = true;
                }
            });

            // if we already have all the teams, don't make the call
            if (!update) {
                return false;
            }

            // let's grab our products and update all the board info
            collectorData.itemsByType('product').then(function(response) {
                _(teams).forEach(function(team) {
                    _(response).forEach(function(board) {
                        if (team.collectorItemId == board.id) {
                            dashboardData.detail(board.options.dashboardId).then(function(result) {
                                teamDashboardDetails[team.collectorItemId] = result;

                                getTeamComponentData(team.collectorItemId);
                            });
                        }
                    });
                });
            });

            return true;
        }

        function getTeamComponentData(collectorItemId) {
            var team = teamDashboardDetails[collectorItemId],
                componentId = team.application.components[0].id,
                start = moment().subtract(90, 'days').format('x');

            function getCaMetric(metrics, name, fallback) {
                var val = fallback === undefined ? false : fallback;
                _(metrics).filter({name:name}).forEach(function(item) {
                    val = item.value;
                });
                return val;
            }

            // get latest build
            buildData
                .details({componentId: componentId, max: 1})
                .then(function(response) {
                    latestBuilds[collectorItemId] = response.result[0];
                });

            // get latest code coverage and issues metrics
            codeAnalysisData
                .staticDetails({componentId: componentId, max:1})
                .then(function(response) {
                    if(response.result[0] && response.result[0].metrics) {
                        var metrics = response.result[0].metrics,
                            lineCoverage = getCaMetric(metrics, 'line_coverage'),
                            violations = getCaMetric(metrics, 'violations');

                        if(lineCoverage !== false) {
                            setTeamSummaryMetric(collectorItemId, 'codeCoverage.number', Math.round(lineCoverage));
                        }

                        if(violations !== false) {
                            setTeamSummaryMetric(collectorItemId, 'codeIssues.number', violations);
                        }
                    }
                });

            // get trends for code coverage and issues
            codeAnalysisData
                .staticDetails({componentId: componentId, dateBegins: start})
                .then(function(response) {

                    // just need the issue and coverage metric values
                    var data = _(response.result)
                        .sortBy('timestamp')
                        .map(function(result) {
                            var daysAgo = -1 * moment.duration(moment().diff(result.timestamp)).asDays(),
                                codeIssues = getCaMetric(result.metrics, 'violations'),
                                codeCoverage = getCaMetric(result.metrics, 'line_coverage');

                            return {
                                codeIssues: [daysAgo, codeIssues],
                                codeCoverage: [daysAgo, codeCoverage]
                            }
                        });

                    // get issues and coverage as their own array
                    var codeIssues = data.pluck('codeIssues').value(),
                        codeCoverage = data.pluck('codeCoverage').value();

                    // get our regression data to determine the trend
                    var codeIssuesResult = regression('linear', codeIssues),
                        codeIssuesTrendUp = codeIssuesResult.equation[0] > 0;

                    var codeCoverageResult = regression('linear', codeCoverage),
                        codeCoverageTrendUp = codeCoverageResult.equation[0] > 0;

                    // set the data
                    setTeamSummaryMetric(collectorItemId, 'codeIssues.trendUp', codeIssuesTrendUp);
                    setTeamSummaryMetric(collectorItemId, 'codeIssues.successState', !codeIssuesTrendUp);

                    setTeamSummaryMetric(collectorItemId, 'codeCoverage.trendUp', codeCoverageTrendUp);
                    setTeamSummaryMetric(collectorItemId, 'codeCoverage.successState', codeCoverageTrendUp);
                });

            // calculate the current state for percent tests passed
            testSuiteData.details({componentId: componentId, max:1})
                .then(function(response) {
                    var totalPassed = 0,
                        totalTests = 0;

                    _(response.result).forEach(function(result) {
                        totalPassed += result.successCount || 0;
                        totalTests += result.totalCount || 0;
                    });

                    var testPassedPercent = totalTests ? totalPassed/totalTests : 0;
                    setTeamSummaryMetric(collectorItemId, 'functionalTestsPassed.number', Math.round(testPassedPercent));
                });

            // calculate trend for percent of tests passed
            testSuiteData.details({componentId: componentId, endDateBegins: start, endDateEnds:moment().format('x')})
                .then(function(response) {
                    var data = _(response.result)
                        .sortBy('timestamp')
                        .map(function(result) {
                            var daysAgo = -1 * moment.duration(moment().diff(result.timestamp)).asDays(),
                                totalPassed = result.successCount || 0,
                                totalTests = result.totalCount,
                                percentPassed = totalTests ? totalPassed/totalTests : 0;

                            return [daysAgo, percentPassed];
                        }).value();

                    var passedPercentResult = regression('linear', data),
                        passedPercentTrendUp = passedPercentResult.equation[0] > 0;

                    setTeamSummaryMetric(collectorItemId, 'functionalTestsPassed.trendUp', passedPercentTrendUp);
                    setTeamSummaryMetric(collectorItemId, 'functionalTestsPassed.successState', passedPercentTrendUp);
                });
        }

        function getSummaryMetric(collectorItemId, type) {
            var metrics = teamSummaryMetrics[collectorItemId];
            return metrics ? metrics[type] : {};
        }

        function editTeam(team) {

            $modal.open({
                templateUrl: 'components/widgets/product/edit-team/edit-team.html',
                controller: 'editTeamController',
                controllerAs: 'ctrl',
                resolve: {
                    editTeamConfig: function() {
                        return {
                            team: team
                        }
                    }
                }
            }).result.then(function(config) {
                if(!config) {
                    return;
                }

                var options = $scope.widgetConfig.options;

                // take the collector item out of the team array
                if(config.remove) {
                    // do remove
                    var keepTeams = [];

                    _(options.teams).forEach(function(team) {
                        if(team.collectorItemId != config.collectorItemId) {
                            keepTeams.push(team);
                        }
                    });

                    options.teams = keepTeams;
                }
                else {
                    for(var x=0;x<options.teams.length;x++) {
                        if(options.teams[x].collectorItemId == config.collectorItemId) {
                            options.teams[x] = config;
                        }
                    }
                }

                updateWidgetOptions(options);
            });
        }

        function addTeam() {

            $modal.open({
                templateUrl: 'components/widgets/product/add-team/add-team.html',
                controller: 'addTeamController',
                controllerAs: 'ctrl'
            }).result.then(function(config) {
                if(!config) {
                    return;
                }

                // prepare our response for the widget upsert
                var options = $scope.widgetConfig.options;

                // make sure it's an array
                if(!options.teams || !options.teams.length) {
                    options.teams = [];
                }

                // add our new config to the array
                options.teams.push(config);

                updateWidgetOptions(options);
            });
        }

        function updateWidgetOptions(options) {
            // get a list of collector ids
            var collectorItemIds = [];
            _(options.teams).forEach(function(team) {
                collectorItemIds.push(team.collectorItemId);
            });

            var data = {
                name: 'product',
                componentId: $scope.dashboard.application.components[0].id,
                collectorItemIds: collectorItemIds,
                options: options
            };

            $scope.upsertWidget(data);
        }

        function teamStageHasCommits(team, stage) {
            return team.stages[stage] && team.stages[stage].commits && team.stages[stage].commits.length;
        }

        function getLatestBuildInfo(collectorItemId) {
            if (!latestBuilds[collectorItemId]) {
                return false;
            }

            var build = latestBuilds[collectorItemId];
            return {
                success: build.buildStatus === 'Success',
                number: build.number
            }
        }

        function viewTeamStageDetails(team, stage) {
            // only show details if we have commits
            if(!teamStageHasCommits(team, stage)) {
                return false;
            }

            $modal.open({
                templateUrl: 'components/widgets/product/environment-commits/environment-commits.html',
                controller: 'productEnvironmentCommitController',
                controllerAs: 'ctrl',
                size: 'lg',
                resolve: {
                    modalData: function () {
                        return {
                            team: team,
                            stage: stage,
                            stages: ctrl.stages
                        };
                    }
                }
            });
        }

        function getStageDurationStats(a) {
            var r = {mean: 0, variance: 0, deviation: 0}, t = a.length;
            for(var m, s = 0, l = t; l--; s += a[l]);
            for(m = r.mean = s / t, l = t, s = 0; l--; s += Math.pow(a[l] - m, 2));
            return r.deviation = Math.sqrt(r.variance = s / t), r;
        }

        function getTeamStageSummary(stageData) {

            return {
                commitsInsideTimeframe: _(stageData.commits).filter(function(c) { return !c.errorState; }).value().length,
                commitsOutsideTimeframe: _(stageData.commits).filter({errorState:true}).value().length,
                lastUpdated: (function(stageData) {
                    if(!stageData.commits) {
                        return false;
                    }

                    var lastUpdated = moment(_(stageData.commits).max('timestamp').value().timestamp);
                    return {
                        longDisplay: lastUpdated.format('MMMM Do YYYY, h:mm:ss a'),
                        shortDisplay: lastUpdated.dash('ago')
                    }
                })(stageData),

                deviation: (function(stageData) {
                    var number = moment.duration(stageData.stageStdDeviation).minutes(),
                        desc = 'min';

                    if(number > 60*24) {
                        desc = 'day';
                        number = Math.round(number / 24 / 60);
                    }
                    else if (number > 60) {
                        desc = 'hour';
                        number = Math.round(number / 60);
                    }

                    return {
                        number: number,
                        descriptor: desc
                    }
                })(stageData),

                average: (function(stageData) {
                    if(!stageData.stageAverageTime) {
                        return false;
                    }
                    var average = moment.duration(stageData.stageAverageTime);

                    return {
                        days: Math.floor(average.asDays()),
                        hours: average.hours(),
                        minutes: average.minutes()
                    }
                })(stageData)
            }
        }

        function getTeamStageData(teams, ctrlStages) {
            var now = moment(),
                nowTimestamp = now.format('x'),
                start = now.subtract(90, 'days').format('x');

            pipelineData.commits(start, nowTimestamp, _(teams).pluck('collectorItemId').value()).then(function(teams) {
                var response = {};

                // start processing response by looping through each team
                _(teams).each(function(team) {
                    var teamStageData = {},
                        stageDurations = {},
                        stages = [].concat(ctrlStages); // create a local copy so lodash doesn't overwrite it

                    // go backward through the stages and define commit data.
                    // reverse should make it easier to calculate time in the previous stage
                    _(stages).reverse().forEach(function(currentStageName) {

                        // make sure there are commits in that stage, otherwise skip it
                        if (!team.stages[currentStageName] || !team.stages[currentStageName].commits || !team.stages[currentStageName].commits.length) {
                            return;
                        }

                        var stage = team.stages[currentStageName], // team data for current stage
                            commits = [], // store our new commit object
                            localStages = [].concat(ctrlStages), // create a copy of the stages
                            previousStages = _(localStages.splice(0, localStages.indexOf(currentStageName))).reverse().value(); // only look for stages before this one

                        // loop through each commit and create our own custom commit object
                        _(stage.commits).forEach(function(commitObj) {
                            var commit = {
                                author: commitObj.commit.scmAuthor || 'NA',
                                message: commitObj.commit.scmCommitLog || 'No message',
                                id: commitObj.commit.scmRevisionNumber,
                                timestamp: commitObj.commit.scmCommitTimestamp,
                                in: {} //placeholder for stage duration data per commit
                            };

                            // make sure this stage exists to track durations
                            if(!stageDurations[currentStageName]) {
                                stageDurations[currentStageName] = [];
                            }

                            // use this commit to calculate time in the current stage
                            var currentStageTimestampCompare = commit.timestamp;
                            if(commitObj.processedTimestamps[currentStageName])
                            {
                                currentStageTimestampCompare = commitObj.processedTimestamps[currentStageName];
                            }

                            // use this time in our metric calculations
                            var timeInCurrentStage = nowTimestamp - currentStageTimestampCompare;
                            stageDurations[currentStageName].push(timeInCurrentStage);

                            // make sure current stage is set
                            commit.in[currentStageName] = timeInCurrentStage;

                            // on each commit, set data for how long it was in each stage by looping
                            // through any previous stage and subtracting its timestamp from the next stage
                            var currentStageTimestamp = commitObj.processedTimestamps[currentStageName];
                            _(previousStages).forEach(function(previousStage) {
                                if(!commitObj.processedTimestamps[previousStage]) {
                                    return;
                                }

                                var previousStageTimestamp = commitObj.processedTimestamps[previousStage],
                                    timeInPreviousStage = currentStageTimestamp - previousStageTimestamp;

                                commit.in[previousStage] = timeInPreviousStage;
                                currentStageTimestamp = previousStageTimestamp;

                                // add this number to the stage duration array so it can be used
                                // to calculate each stages average duration individually
                                if(!stageDurations[previousStage]) {
                                    stageDurations[previousStage] = [];
                                }

                                stageDurations[previousStage].push(timeInPreviousStage);
                            });

                            // add our commit object back
                            commits.push(commit);
                        });

                        teamStageData[currentStageName] = {
                            commits: commits
                        }
                    });

                    // now that we've added all the duration data for all commits in each stage
                    // we can calculate the averages and std deviation
                    _(stageDurations).forEach(function(durationArray, currentStageName) {
                        if(!teamStageData[currentStageName]) {
                            teamStageData[currentStageName] = {};
                        }

                        var stats = getStageDurationStats(durationArray)
                        angular.extend(teamStageData[currentStageName], {
                            stageAverageTime: stats.mean,
                            stageStdDeviation: stats.deviation
                        })
                    });

                    // now that we have average and std deviation we can determine if a commit
                    // has been in the environment for longer than 2 std deviations in which case
                    // it should be marked as a failure
                    _(teamStageData).forEach(function(data, stage) {

                        if(!data.stageStdDeviation || !data.commits) {
                            return;
                        }

                        _(data.commits).forEach(function(commit) {
                            var timeInStage = nowTimestamp - commit.timestamp;

                            commit.errorState = timeInStage > 2 * data.stageStdDeviation;
                        });
                    });

                    _(teamStageData).forEach(function(data, stage) {
                        data.summary = getTeamStageSummary(teamStageData[stage]);
                    });

                    // calculate info used in production
                    var teamProdData = {
                        averageDays: '--',
                        totalCommits: 0
                    },
                        commitTimeToProd = _(team.stages)
                            // limit to prod
                            .filter(function(val, key) {
                                return key == 'Prod'
                            })
                            // get commits
                            .pluck('commits')
                            // make all commits a single array
                            .reduce(function(num, commits){ return num + commits; })
                            // they should, but make sure the commits have a prod timestamp
                            .filter(function(commit) {
                                return commit.processedTimestamps && commit.processedTimestamps['Prod'];
                            })
                            // calculate their time to prod
                            .map(function(commit) {
                                return {
                                    duration: commit.processedTimestamps['Prod'] - commit.commit.scmCommitTimestamp,
                                    commitTimestamp: commit.commit.scmCommitTimestamp
                                };
                            });


                    teamProdData.totalCommits = commitTimeToProd.length;

                    if (commitTimeToProd.length > 1) {
                        var averageDuration = _(commitTimeToProd).pluck('duration').reduce(function(a,b) {
                            return a + b;
                        }) / commitTimeToProd.length;

                        teamProdData.averageDays = Math.floor(moment.duration(averageDuration).asDays());

                        var plotData = _(commitTimeToProd).map(function(ttp) {
                            var daysAgo = -1*moment.duration(moment().diff(ttp.commitTimestamp)).asDays();
                            return [daysAgo, ttp.duration];
                        }).value();

                        var averageToProdResult = regression('linear', plotData);
                        teamProdData.trendUp = averageToProdResult.equation[0] > 0;
                    }

                    // set all the team data in a key that we can
                    // easily get to with collector item id
                    response[team.collectorItemId] = {
                        stages: teamStageData,
                        prod: teamProdData
                    };
                });

                // set our data back on the controller
                for (var collectorItemId in response) {
                    // set the data for a given collectorItemId
                    _(ctrl.configuredTeams).filter({'collectorItemId': collectorItemId}).forEach(function (configuredTeam) {
                        angular.extend(configuredTeam, response[collectorItemId]);
                    });
                }
            });
        }
    }
})();
