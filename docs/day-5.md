# Day 5: Deploying Your AI Agent to SAP BTP Cloud Foundry

In this session, you will package the CAP application built on Day 4 as a Multi-Target Application (MTA) archive and deploy it to SAP BTP Cloud Foundry, wiring it up to SAP AI Core and Identity Authentication Service (IAS) for production use.

---

## Prerequisites

Ensure you have access to the SAP BTP Cockpit:

> **BTP Cockpit (APAC):** https://apac.cockpit.btp.cloud.sap/cockpit

Log in and verify you have:
- An SAP AI Core service instance (existing service bound as `ai-core-us`)
- A Cloud Foundry space in the `us10-003` region (or your assigned region)

---

## Step 1 — Install build tools

### Install the MTA Build Tool (mbt)

`mbt` is the command-line tool that packages your project into an `.mtar` archive for deployment.

```bash
npm install -g mbt
```

### Install `make` (Windows only)

`mbt` requires `make` to execute build scripts. On Windows, install it via Chocolatey.

First, ensure **Chocolatey** is installed. If not, run the following in PowerShell **as Administrator**:

```powershell
Set-ExecutionPolicy Bypass -Scope Process -Force; [System.Net.ServicePointManager]::SecurityProtocol = [System.Net.ServicePointManager]::SecurityProtocol -bor 3072; iex ((New-Object System.Net.WebClient).DownloadString('https://community.chocolatey.org/install.ps1'))
```

Then install `make`:

```powershell
choco install make
```

> macOS/Linux users: `make` is typically pre-installed.

---

## Step 2 — Install the Cloud Foundry CLI

The `cf` CLI is used to authenticate with Cloud Foundry and deploy your application.

**Windows** (via Chocolatey):
```powershell
choco install cloudfoundry-cli
```

**macOS** (via Homebrew):
```bash
brew install cloudfoundry/tap/cf-cli@8
```

Verify the installation:
```bash
cf --version
```

---

## Step 3 — Install the MultiApps CF plugin

The `multiapps` plugin extends the `cf` CLI with the `cf deploy` command needed to deploy `.mtar` archives.

```bash
cf install-plugin multiapps
```

Confirm the installation when prompted.

---

## Step 4 — Add MTA support to the CAP project

Run the CDS `add mta` command to generate an `mta.yaml` deployment descriptor for your project. This file describes all modules, dependencies, and resources that make up your application.

```bash
cds add mta
```

This creates (or updates) `mta.yaml` at the project root.

---

## Step 5 — Build the MTA archive

Package the application into a deployable `.mtar` archive. The output is written to `mta_archives/`.

```bash
mbt build
```

You should see an archive such as `mta_archives/capla_1.0.0.mtar` after a successful build.

---

## Step 6 — Configure AI Core in `mta.yaml`

Open `mta.yaml` and bind the server module to your existing SAP AI Core service instance. Add `ai-core-us` as a required resource under the `capla-srv` module and declare it as an existing Cloud Foundry service.

```yaml
modules:
  - name: capla-srv
    # ... existing properties ...
    requires:
      - name: ai-core-us        # bind to the AI Core service

resources:
  - name: ai-core-us
    type: org.cloudfoundry.existing-service   # reuse a pre-created service instance
```

> The service instance named `ai-core-us` must already exist in your Cloud Foundry space. It is not created by this deployment — only bound.

---

## Step 7 — Add Identity Authentication Service (IAS)

Add IAS as the authentication provider for the deployed application. CDS generates the necessary IAS configuration and updates `mta.yaml` automatically.

```bash
cds add ias
```

---

## Step 8 — Configure IAS in `mta.yaml`

After running `cds add ias`, update `mta.yaml` to configure how the server module consumes the IAS service. This instructs MTA to generate a service key and inject credentials at deploy time.

```yaml
modules:
  - name: capla-srv
    requires:
      - name: capla-ias
        parameters:
          service-key:
            name: capla-ias-service-key    # name of the generated service key
          config:
            credential-type: SECRET        # use client secret credentials
            app-identifier: srv            # identifies this app within IAS
```

> These parameters tell MTA to automatically create and inject an IAS service key into the running application.

---

## Step 9 — Log in to Cloud Foundry

Authenticate with the Cloud Foundry API endpoint using SSO (Single Sign-On). A browser window will open for you to log in with your SAP ID.

```bash
cf login -a https://api.cf.us10-003.hana.ondemand.com --sso
```

Follow the prompts:
1. Open the URL printed in the terminal.
2. Copy the one-time passcode and paste it back into the terminal.
3. Select your org and space when prompted.

---

## Step 10 — Deploy to Cloud Foundry

Deploy the `.mtar` archive using the MultiApps plugin. MTA resolves all module dependencies, creates/binds services, and pushes the Node.js application to Cloud Foundry.

```bash
cf deploy mta_archives/capla_1.0.0.mtar
```

Monitor the output for any errors. On success, the terminal will print the route URL where your `AgentService` is now live.

> If you need to redeploy after changes, rebuild first with `mbt build`, then re-run `cf deploy`.

---

## Step 11 - Test the deployed agent

Create a Service Key for the IAS service instance to obtain credentials for your deployed application. Use these credentials to populate `test/http/.env` file (by duplicating [`test/http/.env.example`](../test/http/.env.example) and filling in the values).

Then execute the HTTP test script in [`/test/http/AgentService.http`](../test/http/AgentService.http) to confirm the deployed agent is functioning correctly.
