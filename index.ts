import * as pulumi from "@pulumi/pulumi";
import * as awsx from "@pulumi/awsx";
import * as eks from "@pulumi/eks";
import * as aws from "@pulumi/aws";
import { PulumiSelfHostedAgentComponent } from "./agent"
import * as k8s from "@pulumi/kubernetes"
import * as iam from "./iam";
import { NatGatewayStrategy } from "@pulumi/awsx/types/enums/ec2";

// IAM roles for the node groups.
const role0 = iam.createRole("example-role0");
const role1 = iam.createRole("example-role1");
const role2 = iam.createRole("example-role2");

// Create a new VPC
const eksVpc = new awsx.ec2.Vpc("eks-vpc", {
    enableDnsHostnames: true,
    numberOfAvailabilityZones: 2,
    natGateways: { strategy: NatGatewayStrategy.Single },
    cidrBlock: "10.0.0.0/16",
});

// Create an EKS cluster.
const cluster = new eks.Cluster("example-managed-nodegroups", {
    skipDefaultNodeGroup: true,
    vpcId: eksVpc.vpcId,
    // Public subnets will be used for load balancers
    publicSubnetIds: eksVpc.publicSubnetIds,
    // Private subnets will be used for cluster nodes
    privateSubnetIds: eksVpc.privateSubnetIds,
    instanceRoles: [role0, role1, role2],
});

const managedNodeGroup = eks.createManagedNodeGroup(
    "example-managed-ng",
    {
        cluster: cluster,
        nodeGroupName: "aws-managed-ng2",
        nodeRoleArn: role2.arn,
        scalingConfig: {
            desiredSize: 2,
            minSize: 2,
            maxSize: 2,
        },
        diskSize: 20,
        instanceTypes: ["t3.medium"],
        labels: { ondemand: "true" },
        tags: { org: "pulumi" },
    },
    cluster
);

// Export the cluster's kubeconfig
export const kubeconfig = cluster.kubeconfig;
const k8sProvider = new k8s.Provider("k8s-provider", { kubeconfig })

const pulumiConfig = new pulumi.Config();
export const ns = new k8s.core.v1.Namespace("stack-namespace", {
    metadata: { name: pulumiConfig.require("agentNamespace") },
}, { provider: k8sProvider });

// Create a Fargate profile
const fargateProfile = new aws.eks.FargateProfile("my-fargate-profile", {
    clusterName: cluster.eksCluster.name,
    podExecutionRoleArn: new aws.iam.Role("fargatePodExecutionRole", {
        assumeRolePolicy: aws.iam.assumeRolePolicyForPrincipal({ Service: "eks-fargate-pods.amazonaws.com" }),
    }).arn,
    subnetIds: eksVpc.privateSubnetIds,
    selectors: [{ namespace: ns.metadata.name, labels: { "app.kubernetes.io/name": "workflow-runner" } }]
});

const agent = new PulumiSelfHostedAgentComponent(
    "self-hosted-agent",
    {
        namespace: ns,
        imageName: pulumiConfig.require("agentImage"),
        selfHostedAgentsAccessToken: pulumiConfig.requireSecret("selfHostedAgentsAccessToken"),
        selfHostedServiceURL: pulumiConfig.get("selfHostedServiceURL") ?? "https://api.pulumi.com",
        imagePullPolicy: pulumiConfig.get("agentImagePullPolicy") || "Always",
        agentReplicas: pulumiConfig.getNumber("agentReplicas") || 3,
    },
    { provider: k8sProvider, dependsOn: [ns] },
)