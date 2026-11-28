// The changes of the reconciler as GraphQL mutations.

import { graphql } from '@octokit/graphql';

import type { OwnedLabel } from '../rules/model.js';
import type { ChangeWriter, PullRequestRef } from './apply.js';

type Graphql = <T>(query: string, variables: Record<string, unknown>) => Promise<T>;

interface PullRequestNode {
  id: string;
  state: 'OPEN' | 'CLOSED' | 'MERGED';
}

const PULL_REQUEST_QUERY = `
  query PullRequestNode($owner: String!, $name: String!, $number: Int!) {
    repository(owner: $owner, name: $name) { pullRequest(number: $number) { id state } }
  }
`;

const LABEL_ID_QUERY = `
  query LabelId($owner: String!, $name: String!, $label: String!) {
    repository(owner: $owner, name: $name) { label(name: $label) { id } }
  }
`;

const ADD_LABEL_MUTATION = `
  mutation AddLabel($pullRequestId: ID!, $labelId: ID!) {
    addLabelsToLabelable(input: { labelableId: $pullRequestId, labelIds: [$labelId] }) { clientMutationId }
  }
`;

const REMOVE_LABEL_MUTATION = `
  mutation RemoveLabel($pullRequestId: ID!, $labelId: ID!) {
    removeLabelsFromLabelable(input: { labelableId: $pullRequestId, labelIds: [$labelId] }) { clientMutationId }
  }
`;

const CREATE_COMMENT_MUTATION = `
  mutation CreateComment($pullRequestId: ID!, $body: String!) {
    addComment(input: { subjectId: $pullRequestId, body: $body }) { clientMutationId }
  }
`;

const EDIT_COMMENT_MUTATION = `
  mutation EditComment($commentId: ID!, $body: String!) {
    updateIssueComment(input: { id: $commentId, body: $body }) { clientMutationId }
  }
`;

const MINIMIZE_COMMENT_MUTATION = `
  mutation MinimizeComment($commentId: ID!) {
    minimizeComment(input: { subjectId: $commentId, classifier: OUTDATED }) { clientMutationId }
  }
`;

const CLOSE_MUTATION = `
  mutation Close($pullRequestId: ID!) {
    closePullRequest(input: { pullRequestId: $pullRequestId }) { clientMutationId }
  }
`;

// A mutation is sent once. A request that failed may have reached GitHub,
// and a comment that is created twice notifies the author twice, so the
// writer does not retry as the reading client does.
export function createChangeWriter(token: string): ChangeWriter {
  const sendOperation: Graphql = graphql.defaults({
    headers: { authorization: `token ${token}` },
  });
  // A mutation names a pull request and a label by node ID. The gathering
  // keeps neither, so the writer asks for each node once.
  const nodes = new Map<string, Promise<unknown>>();
  const nodeOnce = <Node>(
    key: string,
    queryNode: () => Promise<Node | null>,
    nodeDescription: string,
  ): Promise<Node> => {
    let node = nodes.get(key) as Promise<Node> | undefined;
    if (!node) {
      node = queryNode().then((found) => {
        if (found === null) throw new Error(`${nodeDescription} does not exist`);
        return found;
      });
      nodes.set(key, node);
    }
    return node;
  };
  const pullRequestNode = ({ repo, number }: PullRequestRef): Promise<PullRequestNode> =>
    nodeOnce(
      `${repo.owner}/${repo.name}#${number}`,
      async () =>
        (
          await sendOperation<{ repository: { pullRequest: PullRequestNode | null } }>(
            PULL_REQUEST_QUERY,
            { owner: repo.owner, name: repo.name, number },
          )
        ).repository.pullRequest,
      `the pull request ${repo.owner}/${repo.name}#${number}`,
    );
  const pullRequestId = async (pr: PullRequestRef): Promise<string> =>
    (await pullRequestNode(pr)).id;
  const labelId = async ({ repo }: PullRequestRef, label: OwnedLabel): Promise<string> =>
    (
      await nodeOnce(
        `${repo.owner}/${repo.name}|${label}`,
        async () =>
          (
            await sendOperation<{ repository: { label: { id: string } | null } }>(LABEL_ID_QUERY, {
              owner: repo.owner,
              name: repo.name,
              label,
            })
          ).repository.label,
        `the label ${label} of ${repo.owner}/${repo.name}`,
      )
    ).id;

  return {
    async isOpen(pr) {
      return (await pullRequestNode(pr)).state === 'OPEN';
    },
    async addLabel(pr, label) {
      await sendOperation(ADD_LABEL_MUTATION, {
        pullRequestId: await pullRequestId(pr),
        labelId: await labelId(pr, label),
      });
    },
    async removeLabel(pr, label) {
      await sendOperation(REMOVE_LABEL_MUTATION, {
        pullRequestId: await pullRequestId(pr),
        labelId: await labelId(pr, label),
      });
    },
    async createComment(pr, body) {
      await sendOperation(CREATE_COMMENT_MUTATION, {
        pullRequestId: await pullRequestId(pr),
        body,
      });
    },
    async editComment(commentId, body) {
      await sendOperation(EDIT_COMMENT_MUTATION, { commentId, body });
    },
    async minimizeComment(commentId) {
      await sendOperation(MINIMIZE_COMMENT_MUTATION, { commentId });
    },
    async close(pr) {
      await sendOperation(CLOSE_MUTATION, { pullRequestId: await pullRequestId(pr) });
    },
  };
}
