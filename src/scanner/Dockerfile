FROM public.ecr.aws/lambda/nodejs:20

# Install git for cloning repositories
RUN dnf install -y git && dnf clean all

COPY package*.json ./
RUN npm ci --production

COPY . .

CMD ["index.handler"]
