# Process Lambda — packaged as a container image because the
# @imgly/background-removal-node ML model + sharp + ONNX runtime push the
# total package over the 250 MB unzipped limit for regular zip lambdas.
# Container images on Lambda can be up to 10 GB.

FROM public.ecr.aws/lambda/nodejs:20

# Copy dependency manifests first so Docker can cache the npm install layer
# across rebuilds when only the source changes.
COPY package.json package-lock.json* ${LAMBDA_TASK_ROOT}/

# Install production dependencies inside the Lambda runtime image so the
# native binaries (sharp, onnxruntime-node) are built for Amazon Linux 2.
RUN npm install --omit=dev

# Copy the function source.
COPY index.mjs ${LAMBDA_TASK_ROOT}/

# Lambda's runtime user (sbx_user1051) needs read+execute on everything in
# the task root. Without this, the bootloader gets EACCES on index.mjs.
RUN chmod -R a+rX ${LAMBDA_TASK_ROOT}

# Lambda's container runtime invokes the handler exported as
# `handler` from the file named here.
CMD [ "index.handler" ]
