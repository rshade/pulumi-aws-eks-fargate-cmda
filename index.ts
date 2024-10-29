import * as pulumi from "@pulumi/pulumi";
import * as awsx from "@pulumi/awsx";
import * as eks from "@pulumi/eks";
import * as aws from "@pulumi/aws";
import { PulumiSelfHostedAgentComponent } from "./customer-managed-deployment-agent/kubernetes/agent"

// Create a VPC
const vpc = new awsx.ec2.Vpc("my-vpc", {
    cidrBlock: "10.0.0.0/16",
    numberOfAvailabilityZones: 2,
    subnetSpecs: [
        { type: "Public" },
        { type: "Private" }
    ],
    tags: { "Name": "my-vpc" }
})
const managedPolicyArns: string[] = [
    "arn:aws:iam::aws:policy/AmazonEKSWorkerNodePolicy",
    "arn:aws:iam::aws:policy/AmazonEKS_CNI_Policy",
    "arn:aws:iam::aws:policy/AmazonEC2ContainerRegistryReadOnly",
];

// Creates a role and attches the EKS worker node IAM managed policies
export function createRole(name: string): aws.iam.Role {
    const role = new aws.iam.Role(name, {
        assumeRolePolicy: aws.iam.assumeRolePolicyForPrincipal({
            Service: "ec2.amazonaws.com",
        }),
    });

    let counter = 0;
    for (const policy of managedPolicyArns) {
        // Create RolePolicyAttachment without returning it.
        const rpa = new aws.iam.RolePolicyAttachment(`${name}-policy-${counter++}`,
            { policyArn: policy, role: role },
        );
    }

    return role;
}

const eksRole = createRole("eksRole")
const instanceProfile0 = new aws.iam.InstanceProfile("example-instanceProfile0", { role: eksRole });

// Create an EKS cluster
const cluster = new eks.Cluster("my-cluster", {
    vpcId: vpc.vpc.id,
    subnetIds: vpc.privateSubnetIds,
    version: "1.29",
    // instanceRole: eksRole,
});

// Create a dedicated node group
const nodeGroup = new eks.NodeGroup("my-nodegroup", {
    cluster: cluster,
    nodeSubnetIds: vpc.privateSubnetIds,
    desiredCapacity: 2,
    maxSize: 3,
    minSize: 1,
    instanceType: "t3.medium"
});

// Create a Fargate profile
const fargateProfile = new aws.eks.FargateProfile("my-fargate-profile", {
    clusterName: cluster.eksCluster.name,
    podExecutionRoleArn: new aws.iam.Role("fargatePodExecutionRole", {
        assumeRolePolicy: aws.iam.assumeRolePolicyForPrincipal({ Service: "eks-fargate-pods.amazonaws.com" }),
    }).arn,
    subnetIds: vpc.privateSubnetIds,
    selectors: [{ namespace: "default", labels: { "app.kubernetes.io/name": "workflow-runner" } }]
});

// Export the cluster's kubeconfig
export const kubeconfig = cluster.kubeconfig;