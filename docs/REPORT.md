# SoberAF Sticker Studio
**AWS Compute Class Final Project: Technical Report**

**Author:** Dave Liloia
**Course:** AWS Compute Class
**Submitted:** April 2026
**GitHub:** https://github.com/dliloia/sober-af-sticker-studio
**Live URL:** http://soberaf-sticker-studio-frontend-118550023629.s3-website-us-east-1.amazonaws.com
**Demo Video:** https://www.loom.com/share/063f5af1fc654162a357cbf67671d08c

---

## 1. Executive Summary

**SoberAF Sticker Studio** is an event-driven serverless application that turns a one-line text prompt into print-ready sticker artwork in three sizes, automatically. I built this as a production back-office tool for [SoberAFStickers.com](https://soberafstickers.com), a real e-commerce shop I run, where every new sticker design previously required hand-drawing by an artist, manual background removal, and resizing in Photoshop. This used to take up to a week from start to finish and now takes about thirty seconds end-to-end.

The architecture is fully serverless: AWS Lambda is the primary compute service, Amazon S3 is the supporting service that doubles as object storage and the static-site host, and Amazon API Gateway, Amazon DynamoDB, Amazon ECR, AWS CloudFormation (via SAM), Amazon CloudWatch, and AWS IAM round out the stack. The OpenAI `gpt-image-1` model handles image generation, and an open-source U2-Net background-removal model runs inside the Process Lambda as a Docker container image for automatic die-cutting.

This project maps to **Project Category B (Serverless Application)** in the assignment brief, specifically an image-processing pipeline of the form *upload → Lambda → resize → store*.

---

## 2. Architecture Design

### Architecture diagram

*(See `docs/architecture-diagram.png` and Appendix A.)*

### Component walkthrough

**Frontend (Amazon S3 static website).** A single-page vanilla HTML/JS image gallery served out of an S3 bucket configured for website hosting. It talks to the API directly with `fetch`. S3 static hosting keeps the cost at zero.

**API Gateway (REST).** Exposes three endpoints: `POST /generate`, `GET /designs`, and `DELETE /designs/{designId}`. CORS is enabled so the static site can call it from the browser.

**Generate Lambda.** Called on `POST /generate`. It adds a brand-style prompt to the user's input, calls the OpenAI `gpt-image-1` API with `background: "transparent"`, decodes the returned PNG, writes it to the **Raw S3 bucket**, and creates a DynamoDB row with status `raw`. Returns the new `designId` to the caller.

**Raw S3 bucket.** Private bucket holding the original 1024x1024 PNG from the model. Has an `s3:ObjectCreated:*` notification wired to the Process Lambda, so uploading a new object fires the next stage of the pipeline. Public access is fully blocked. AES-256 encryption is enabled.

**Process Lambda.** Triggered by the S3 event from the raw bucket. Downloads the PNG, runs it through `@imgly/background-removal-node`, then uses `sharp` to produce three print sizes (600x600, 900x900, 1200x1200) at 300 DPI with a small "SoberAF" watermark. Results go to the **Processed S3 bucket** and DynamoDB is updated to status `processed`. This is the only Lambda in the stack deployed as a container image because the ONNX runtime, U2-Net model weights, and sharp push the package past Lambda's 250 MB zip limit.

**Processed S3 bucket.** Public-read bucket holding the three processed PNGs per design under `{designId}/{small|medium|large}.png`.

**DynamoDB table (`soberaf-sticker-studio-designs`).** Pay-per-request table keyed by `designId`. Stores the user prompt, full prompt, S3 keys, status, and timestamps.

**ListDesigns Lambda.** This function scans the DynamoDB table on `GET /designs` and returns the list to the frontend, sorted newest first. This lets me render the website gallery.

**Delete Lambda.** Handles `DELETE /designs/{designId}` by removing the original PNG from the raw bucket, all three sized PNGs from the processed bucket, and the metadata row from DynamoDB. This is wired into the gallery UI. I did this because sometimes the images generated are not of a high quality.

**Amazon ECR repository.** Auto-created by SAM on first deploy of the container-image Process Lambda. Holds the Docker image.

**AWS SAM/CloudFormation.** The entire stack is defined in `infra/template.yaml`. One `sam deploy` brings up every resource; one `sam delete` tears it down.

**CloudWatch Logs + Alarms.** All four Lambdas log to CloudWatch. Two alarms fire when the Generate or Process function hits 3+ errors in a 5-minute window. I used CloudWatch Logs Insights a lot during development to debug the background-removal pipeline.

### Why these services

I chose **Lambda over EC2 or ECS** because the workload is event-driven and spiky. Most of the day the system is idle, and when a sticker is being designed there are just two short bursts of work. Lambda's scale-to-zero pricing means I pay nothing when idle, which matters for a real shop with low daily volume. EC2 would have a fixed minimum cost; Fargate would solve cold starts but at the cost of always-on bills.

I chose **S3** for storage because S3 event notifications give me the pipeline trigger for free, no SQS or SNS needed. I chose **DynamoDB over RDS** because the data model is one table, one key, no joins, and pay-per-request matches the scale-to-zero pricing of everything else. The **container image deployment** for the Process Lambda was forced on me by the size of the ML model (see Section 3).

---

## 3. Implementation Details

### Setup Instructions

```bash
# Clone the repo
git clone https://github.com/dliloia/sober-af-sticker-studio.git
cd sober-af-sticker-studio

# Install dependencies
cd src/generate && npm install && cd ../..
cd src/process && npm install && cd ../..

# Build and deploy with SAM
cd infra
sam build --use-container
sam deploy \
  --parameter-overrides OpenAIApiKey=<your-openai-key> \
  --capabilities CAPABILITY_NAMED_IAM \
  --resolve-s3 \
  --resolve-image-repos

# Upload the frontend (update API_BASE_URL and PROCESSED_BUCKET_URL first)
aws s3 sync ../src/frontend/ s3://<frontend-bucket-name>
```

The first deploy builds the Process Lambda container image (~5 minutes); subsequent deploys reuse Docker layer caching and are much faster.

### Key configurations

- **`infra/template.yaml`** is the single SAM template defining all resources: four Lambda functions, four IAM roles, three S3 buckets, the DynamoDB table, API Gateway, S3 trigger permissions, and two CloudWatch alarms.
- **`src/process/Dockerfile`** builds on `public.ecr.aws/lambda/nodejs:20`, runs `npm install --omit=dev` inside the container for Linux-native binaries, and runs `chmod -R a+rX` so the Lambda runtime user can read the files.
- **`src/process/.dockerignore`** excludes the host `node_modules` so Docker doesn't pull macOS binaries into the Linux image.
- The **OpenAI prompt prefix** (in `src/generate/index.mjs`) is a verbose negative-instruction string that forbids backgrounds, shadows, and ground. These artifacts broke the early image-processing heuristics and forced the ML pivot.

### Challenges & Solutions

**Challenge 1: Background removal.** The first few iterations of the Process Lambda tried to detect backgrounds with image-processing heuristics (flood fill, morphological closing, blob filtering). Each approach was beaten by a different generated image: a sun on a cream backdrop, a moon with hatched shadows, a skull on a dark dome. The heuristics were brittle because the model was producing genuinely opaque pixels, not just "almost white" ones.
**Solution:** Switched to `@imgly/background-removal-node`, a U2-Net based ML model that handles arbitrary backgrounds correctly.

**Challenge 2: Lambda zip exceeded 250 MB.** Adding the ML model + ONNX runtime made the package ~351 MB.
**Solution:** Switched to **container image deployment** (up to 10 GB allowed). Required a Dockerfile, changing SAM to `PackageType: Image`, and removing `Runtime`/`Handler` from that function.

**Challenge 3: CloudFormation refused to replace the custom-named Lambda.** Switching from zip to image requires replacement, but CloudFormation can't replace a function with a hardcoded name (it tries to create the new one before deleting the old one, and the names collide).
**Solution:** Removed `FunctionName` and let CloudFormation generate a unique name. Template references like `!Ref ProcessFunction` kept working since they're symbolic.

**Challenge 4: `EACCES` at cold start.** The container deployed fine but crashed with a permission error on `index.mjs`. Lambda's runtime user isn't root and couldn't read the copied files.
**Solution:** Added `RUN chmod -R a+rX ${LAMBDA_TASK_ROOT}` to the Dockerfile. (Tried `COPY --chmod=644` first but SAM doesn't enable BuildKit.)

### Testing

1. **End-to-end smoke tests.** Generate a sticker from the frontend, verify the three sizes appear in the gallery with transparent backgrounds.
2. **CloudWatch Logs Insights.** Every Lambda logs the design ID, so one query traces a request across both functions.
3. **CloudWatch alarms** catch silent failures on Generate and Process.
4. **Edge case testing.** Re-tested all the failure modes from the background-removal saga (cream backdrop, ground hatching, dark dome) to confirm the ML model handled them.

---

## 4. Cloud Engineering Best Practices

### Security

- **Least-privilege IAM.** Each Lambda has its own role with only the specific permissions it needs. Generate can only write to the raw bucket and put items in DynamoDB. Process can only read from raw, write to processed, and update DynamoDB. ListDesigns can only scan the table. Delete can only act on its three resources. Nothing gets broad admin access.
- **S3 access control.** The raw bucket has all four `BlockPublicAccess` flags enabled. Processed and frontend buckets allow public reads through narrow bucket policies (`s3:GetObject` only).
- **Secrets management.** The OpenAI API key is a CloudFormation parameter with `NoEcho: true`, injected as an environment variable. It never appears in stack events.
- **Encryption at rest.** All three S3 buckets use AES-256 server-side encryption.

### Scalability

Everything scales automatically. Lambda scales out to 1000 concurrent executions per function (way more than this workload needs). S3 and DynamoDB (pay-per-request) scale without any configuration. There are no servers to size or load balancers to tune.

### High Availability

Every service in this stack is multi-AZ by default: Lambda, S3, DynamoDB, and API Gateway all run across multiple availability zones in `us-east-1`. There's no single-AZ resource and no failover logic to write.

### Cost Analysis

With my expected volume of ~50 sticker designs/month:

| Resource | Free Tier (12 mo) | Estimated Monthly Cost |
|---|---|---|
| Lambda invocations (4 functions x ~50 designs) | 1M requests | $0.00 |
| Lambda compute (Process at 3008 MB x ~25 s x 50) | 400K GB-sec | $0.00 |
| S3 storage (3 buckets, ~500 MB total) | 5 GB | $0.00 |
| DynamoDB pay-per-request | 25 WCU + 25 RCU | $0.00 |
| API Gateway REST | 1M calls | $0.00 |
| CloudWatch Logs (~50 MB) | 5 GB ingest | $0.00 |
| ECR storage (~400 MB image) | 500 MB | $0.00 |
| **AWS subtotal** | | **$0.00** |
| OpenAI `gpt-image-1` (~$0.04/image) | n/a | ~$2.00 |
| **Total** | | **~$2.00/month** |

After the free tier expires, the AWS portion would be roughly $0.50-$1.00/month. Most of the cost is on the OpenAI side.

### Monitoring

CloudWatch Logs are enabled for all Lambdas. Error alarms on Generate and Process fire at 3+ errors per 5-minute window. Every log line includes the `designId` so I can trace a full pipeline run with one Logs Insights query.

---

## 5. Lessons Learned & Future Improvements

### What I learned

The biggest lesson was that **you can't beat a real ML model with hand-rolled image-processing heuristics**. I spent a full day trying flood-fill, morphological closing, and connected-components approaches before I accepted that the U2-Net model was the right answer. And once you bring in a real ML dependency, you've outgrown Lambda's zip deployment. Sharp + ONNX + the model weights are just bigger than 250 MB, period. Container images aren't optional at that point; they're the only way.

I also learned that CloudFormation really cares about resource naming. Setting a hardcoded `FunctionName` looked harmless at first but caused a painful deployment failure later when I needed to replace the function. Letting CloudFormation generate names is the safer default.

The **S3-to-Lambda event trigger** turned out to be a really clean way to wire a pipeline: no SQS, no SNS, no polling. Just a notification config on the bucket and a Lambda permission. Two blocks of YAML.

### What I would do differently

Start with container image deployment for the Process Lambda from day one instead of hitting the 250 MB wall and pivoting mid-project. Also, set up saved CloudWatch Logs Insights queries in the SAM template instead of retyping them in the console every time.

### How I would extend this

- **CloudFront** in front of the processed and frontend buckets for caching, HTTPS, and a custom domain.
- **Step Functions** to orchestrate the pipeline with retries and a visible state machine instead of relying on S3 events.
- **Cognito** for authentication so the tool isn't open to anyone who finds the URL.
- **SES notifications** when a design finishes processing, so I'm not refreshing the gallery.

---

## 6. Resource Cleanup Plan

```bash
# Empty the S3 buckets first
aws s3 rm s3://soberaf-sticker-studio-raw-118550023629 --recursive
aws s3 rm s3://soberaf-sticker-studio-processed-118550023629 --recursive
aws s3 rm s3://soberaf-sticker-studio-frontend-118550023629 --recursive

# Delete the ECR images
aws ecr batch-delete-image \
  --repository-name soberafstickerstudioe99dc7bf/processfunction083459e4repo \
  --image-ids imageTag=latest

# Delete the CloudFormation stack
sam delete --stack-name soberaf-sticker-studio
```

**Note:** I've chosen to leave this stack running after the grading window because it's the production tool for SoberAFStickers.com. The serverless architecture means idle costs are effectively zero, so keeping it up costs nothing while it continues to serve a real business. If costs ever drift above free tier, the cleanup commands above take under a minute.

---

## Appendix A: Architecture Diagram

*(See `docs/architecture-diagram.png`.)*

## Appendix B: Screenshots

*(See `screenshots/` folder in the repository.)*

1. **AWS Console: CloudFormation stack outputs**
2. **Lambda Console** showing all four functions
3. **S3 Console** showing the three buckets
4. **DynamoDB Console** with sample rows
5. **API Gateway Console** showing the three routes
6. **CloudWatch Logs Insights** query tracing a design
7. **CloudWatch Alarms** for Generate and Process
8. **Frontend gallery** in the browser (URL bar visible)
9. **A generated sticker** in all three sizes

## Appendix C: External Resources & Citations

- **OpenAI `gpt-image-1` API:** https://platform.openai.com/docs/guides/images
- **`@imgly/background-removal-node`:** https://github.com/imgly/background-removal-js (Apache 2.0)
- **`sharp` image processing library:** https://sharp.pixelplumbing.com (Apache 2.0)
- **AWS SAM:** https://docs.aws.amazon.com/serverless-application-model/
- **AWS Lambda container image docs:** https://docs.aws.amazon.com/lambda/latest/dg/images-create.html
- **AWS Lambda Node.js base image:** `public.ecr.aws/lambda/nodejs:20`
- AWS documentation and CloudWatch Logs Insights docs were used as references throughout. No tutorial code was copied.
