// Jenkins pipeline for jka-web: build the WASM engine + game module on the build server and deploy
// to the test app server. Never touches production (jka.virtastic.app is a separate path).
//
// The job checks this repo out on the builder (Jenkins + Docker live there), so the workspace IS the
// synced tree — ci/jenkins/sync-to-builder.sh is only for the manual laptop-driven flow. config.env
// is gitignored and absent in a fresh checkout, so every value comes from `environment {}` below
// (env overrides config.env per the scripts' precedence).
pipeline {
  agent any
  options { timestamps(); disableConcurrentBuilds(); timeout(time: 60, unit: 'MINUTES') }
  environment {
    TAG       = 'jka:test'
    NAME      = 'jka-test'
    PORT      = '8083'
    TEST_HOST = 'user@<test-host>'
    SSH_KEY   = '/var/jenkins_home/.ssh/jka-deploy'   // builder->test key, lives on the builder
    SMOKE_URL = 'https://jka.dev.virtastic.app'
  }
  stages {
    stage('Build')  { steps { sh 'SRC="$WORKSPACE" TAG="$TAG" ci/jenkins/build-engine.sh' } }
    stage('Deploy') { steps { sh 'ci/jenkins/deploy-test.sh' } }
    stage('Smoke') {
      steps {
        // Prefer the public origin once DNS + ingress exist; until then smoke-test the container
        // directly on the test host so the stage is meaningful from day one.
        sh '''
          if [ -n "$SMOKE_URL" ] && curl -sf -o /dev/null --max-time 8 "$SMOKE_URL/" 2>/dev/null; then
            ci/jenkins/smoke-test.sh "$SMOKE_URL"
          else
            echo "public origin not reachable yet; smoke-testing the container directly"
            ci/jenkins/smoke-test.sh "http://<test-host>:$PORT"
          fi
        '''
      }
    }
  }
  post {
    success { echo "jka built and deployed to the test server on :${env.PORT}" }
    failure { echo 'jka test pipeline failed — see stage logs' }
  }
}
