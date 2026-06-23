import type { getOctokit } from '@actions/github'

type Octokit = ReturnType<typeof getOctokit>

export interface ProjectContext {
  projectId: string
  statusFieldId: string
  /** lowercased option name -> optionId */
  statusOptionIdByName: Map<string, string>
  /** optionId -> canonical option name */
  statusNameById: Map<string, string>
  /** id of the expiry Text field, or null if the project has no such field */
  expiryFieldId: string | null
}

export interface ItemState {
  itemId: string
  statusOptionId: string | null
  statusName: string | null
  /** raw text of the expiry field, or null if unset/absent */
  expiryText: string | null
}

interface ProjectNode {
  id: string
  title: string
}

const PAGE = 50

/** Find a Projects v2 board by title: first repo-linked, then owner-level. */
export async function resolveProjectId(
  octokit: Octokit,
  owner: string,
  repo: string,
  title: string,
): Promise<string> {
  const want = title.trim()

  // 1. Projects linked to the repository.
  let cursor: string | null = null
  do {
    const res: {
      repository: { projectsV2: { nodes: ProjectNode[]; pageInfo: { hasNextPage: boolean; endCursor: string | null } } } | null
    } = await octokit.graphql(
      `query($owner:String!,$repo:String!,$cursor:String){
        repository(owner:$owner,name:$repo){
          projectsV2(first:${PAGE},after:$cursor){ nodes{ id title } pageInfo{ hasNextPage endCursor } }
        }
      }`,
      { owner, repo, cursor },
    )
    const pv2 = res.repository?.projectsV2
    if (!pv2) break
    const hit = pv2.nodes.find((n) => n.title.trim() === want)
    if (hit) return hit.id
    cursor = pv2.pageInfo.hasNextPage ? pv2.pageInfo.endCursor : null
  } while (cursor)

  // 2. Projects owned by the org/user (board may not be repo-linked).
  cursor = null
  do {
    const res: {
      repositoryOwner: { projectsV2?: { nodes: ProjectNode[]; pageInfo: { hasNextPage: boolean; endCursor: string | null } } } | null
    } = await octokit.graphql(
      `query($owner:String!,$cursor:String){
        repositoryOwner(login:$owner){
          ... on ProjectV2Owner {
            projectsV2(first:${PAGE},after:$cursor){ nodes{ id title } pageInfo{ hasNextPage endCursor } }
          }
        }
      }`,
      { owner, cursor },
    )
    const pv2 = res.repositoryOwner?.projectsV2
    if (!pv2) break
    const hit = pv2.nodes.find((n) => n.title.trim() === want)
    if (hit) return hit.id
    cursor = pv2.pageInfo.hasNextPage ? pv2.pageInfo.endCursor : null
  } while (cursor)

  throw new Error(`Could not find a Projects v2 board titled ${JSON.stringify(want)} linked to ${owner}/${repo} or owned by ${owner}. Check the title and that the token can see the board.`)
}

interface FieldNode {
  __typename: string
  id: string
  name: string
  dataType?: string
  options?: { id: string; name: string }[]
}

/** Load the status single-select field (id + options) and the expiry text field id. */
export async function loadFields(
  octokit: Octokit,
  projectId: string,
  statusFieldName: string,
  expiryFieldName: string,
): Promise<Omit<ProjectContext, 'projectId'>> {
  const nodes: FieldNode[] = []
  let cursor: string | null = null
  do {
    const res: {
      node: { fields: { nodes: FieldNode[]; pageInfo: { hasNextPage: boolean; endCursor: string | null } } }
    } = await octokit.graphql(
      `query($id:ID!,$cursor:String){
        node(id:$id){ ... on ProjectV2 {
          fields(first:${PAGE},after:$cursor){
            nodes{
              __typename
              ... on ProjectV2FieldCommon { id name }
              ... on ProjectV2Field { dataType }
              ... on ProjectV2SingleSelectField { options { id name } }
            }
            pageInfo{ hasNextPage endCursor }
          }
        } }
      }`,
      { id: projectId, cursor },
    )
    nodes.push(...res.node.fields.nodes)
    cursor = res.node.fields.pageInfo.hasNextPage ? res.node.fields.pageInfo.endCursor : null
  } while (cursor)

  const status = nodes.find((n) => n.name === statusFieldName && n.__typename === 'ProjectV2SingleSelectField')
  if (!status) {
    const named = nodes.find((n) => n.name === statusFieldName)
    throw new Error(
      named
        ? `Field ${JSON.stringify(statusFieldName)} is a ${named.__typename}, not a single-select field.`
        : `Project has no single-select field named ${JSON.stringify(statusFieldName)}.`,
    )
  }

  const statusOptionIdByName = new Map<string, string>()
  const statusNameById = new Map<string, string>()
  for (const o of status.options ?? []) {
    statusOptionIdByName.set(o.name.toLowerCase(), o.id)
    statusNameById.set(o.id, o.name)
  }

  // The expiry field, if present, must be a Text field (we store an ISO datetime string).
  let expiryFieldId: string | null = null
  const expiry = nodes.find((n) => n.name === expiryFieldName)
  if (expiry) {
    if (expiry.__typename !== 'ProjectV2Field' || expiry.dataType !== 'TEXT') {
      throw new Error(`Expiry field ${JSON.stringify(expiryFieldName)} must be a Text field, but it is ${expiry.dataType ?? expiry.__typename}.`)
    }
    expiryFieldId = expiry.id
  }

  return { statusFieldId: status.id, statusOptionIdByName, statusNameById, expiryFieldId }
}

interface FieldValue {
  __typename: string
  text?: string
  optionId?: string
  field?: { id?: string; name?: string }
}

function readItemState(
  itemId: string,
  fieldValues: FieldValue[],
  statusFieldId: string,
  expiryFieldId: string | null,
): ItemState {
  let statusOptionId: string | null = null
  let expiryText: string | null = null
  for (const fv of fieldValues) {
    if (fv.__typename === 'ProjectV2ItemFieldSingleSelectValue' && fv.field?.id === statusFieldId) {
      statusOptionId = fv.optionId ?? null
    }
    if (expiryFieldId && fv.__typename === 'ProjectV2ItemFieldTextValue' && fv.field?.id === expiryFieldId) {
      expiryText = fv.text ?? null
    }
  }
  return { itemId, statusOptionId, statusName: null, expiryText }
}

const ITEM_FIELD_VALUES = `
  fieldValues(first:100){
    nodes{
      __typename
      ... on ProjectV2ItemFieldSingleSelectValue { optionId field { ... on ProjectV2FieldCommon { id name } } }
      ... on ProjectV2ItemFieldTextValue { text field { ... on ProjectV2FieldCommon { id name } } }
    }
    pageInfo{ hasNextPage }
  }`

/** Find the project item for an issue (matching our project), with its status + expiry. */
export async function getIssueItem(
  octokit: Octokit,
  owner: string,
  repo: string,
  issueNumber: number,
  ctx: ProjectContext,
): Promise<ItemState | null> {
  let cursor: string | null = null
  do {
    const res: {
      repository: { issue: { projectItems: { nodes: { id: string; project: { id: string }; fieldValues: { nodes: FieldValue[]; pageInfo: { hasNextPage: boolean } } }[]; pageInfo: { hasNextPage: boolean; endCursor: string | null } } } | null } | null
    } = await octokit.graphql(
      `query($owner:String!,$repo:String!,$num:Int!,$cursor:String){
        repository(owner:$owner,name:$repo){
          issue(number:$num){
            projectItems(first:50,after:$cursor){
              nodes{ id project{ id } ${ITEM_FIELD_VALUES} }
              pageInfo{ hasNextPage endCursor }
            }
          }
        }
      }`,
      { owner, repo, num: issueNumber, cursor },
    )
    const items = res.repository?.issue?.projectItems
    if (!items) return null
    const item = items.nodes.find((n) => n.project.id === ctx.projectId)
    if (item) {
      if (item.fieldValues.pageInfo.hasNextPage) {
        throw new Error(`Item ${item.id} has more than 100 field values; refusing to act on a partial read.`)
      }
      return readItemState(item.id, item.fieldValues.nodes, ctx.statusFieldId, ctx.expiryFieldId)
    }
    cursor = items.pageInfo.hasNextPage ? items.pageInfo.endCursor : null
  } while (cursor)
  return null
}

export interface ClaimedItem {
  itemId: string
  issueNumber: number
  issueOwner: string
  issueRepo: string
  assignees: string[]
  statusOptionId: string | null
  expiryText: string | null
}

/** Enumerate all board items whose status is one of `statusOptionIds` (for the sweep). */
export async function listItemsByStatus(
  octokit: Octokit,
  ctx: ProjectContext,
  statusOptionIds: Set<string>,
): Promise<ClaimedItem[]> {
  const out: ClaimedItem[] = []
  let cursor: string | null = null
  do {
    const res: {
      node: { items: { nodes: {
        id: string
        content: { __typename: string; number?: number; assignees?: { nodes: { login: string }[] }; repository?: { name: string; owner: { login: string } } } | null
        fieldValues: { nodes: FieldValue[]; pageInfo: { hasNextPage: boolean } }
      }[]; pageInfo: { hasNextPage: boolean; endCursor: string | null } } }
    } = await octokit.graphql(
      `query($id:ID!,$cursor:String){
        node(id:$id){ ... on ProjectV2 {
          items(first:100,after:$cursor){
            nodes{
              id
              content{
                __typename
                ... on Issue { number assignees(first:20){ nodes{ login } } repository{ name owner{ login } } }
              }
              ${ITEM_FIELD_VALUES}
            }
            pageInfo{ hasNextPage endCursor }
          }
        } }
      }`,
      { id: ctx.projectId, cursor },
    )
    const items = res.node.items
    for (const it of items.nodes) {
      if (it.content?.__typename !== 'Issue' || it.content.number === undefined) continue
      if (it.fieldValues.pageInfo.hasNextPage) {
        throw new Error(`Item ${it.id} has more than 50 field values; refusing to act on a partial read.`)
      }
      const state = readItemState(it.id, it.fieldValues.nodes, ctx.statusFieldId, ctx.expiryFieldId)
      if (!state.statusOptionId || !statusOptionIds.has(state.statusOptionId)) continue
      out.push({
        itemId: it.id,
        issueNumber: it.content.number,
        issueOwner: it.content.repository?.owner.login ?? '',
        issueRepo: it.content.repository?.name ?? '',
        assignees: (it.content.assignees?.nodes ?? []).map((a) => a.login),
        statusOptionId: state.statusOptionId,
        expiryText: state.expiryText,
      })
    }
    cursor = items.pageInfo.hasNextPage ? items.pageInfo.endCursor : null
  } while (cursor)
  return out
}

/** Add an issue (by its content node id) to the board; returns the item id. The API is
 *  idempotent: adding content already on the board returns its existing item unchanged. */
export async function addIssueToProject(octokit: Octokit, ctx: ProjectContext, contentId: string): Promise<string> {
  const res: { addProjectV2ItemById: { item: { id: string } } } = await octokit.graphql(
    `mutation($p:ID!,$c:ID!){
      addProjectV2ItemById(input:{projectId:$p,contentId:$c}){ item{ id } }
    }`,
    { p: ctx.projectId, c: contentId },
  )
  return res.addProjectV2ItemById.item.id
}

export async function setStatus(octokit: Octokit, ctx: ProjectContext, itemId: string, optionId: string): Promise<void> {
  await octokit.graphql(
    `mutation($p:ID!,$i:ID!,$f:ID!,$o:String!){
      updateProjectV2ItemFieldValue(input:{projectId:$p,itemId:$i,fieldId:$f,value:{singleSelectOptionId:$o}}){ projectV2Item{ id } }
    }`,
    { p: ctx.projectId, i: itemId, f: ctx.statusFieldId, o: optionId },
  )
}

export async function setExpiry(octokit: Octokit, ctx: ProjectContext, itemId: string, iso: string): Promise<void> {
  if (!ctx.expiryFieldId) throw new Error('No expiry field configured on this project.')
  await octokit.graphql(
    `mutation($p:ID!,$i:ID!,$f:ID!,$t:String!){
      updateProjectV2ItemFieldValue(input:{projectId:$p,itemId:$i,fieldId:$f,value:{text:$t}}){ projectV2Item{ id } }
    }`,
    { p: ctx.projectId, i: itemId, f: ctx.expiryFieldId, t: iso },
  )
}

export async function clearExpiry(octokit: Octokit, ctx: ProjectContext, itemId: string): Promise<void> {
  if (!ctx.expiryFieldId) return
  await octokit.graphql(
    `mutation($p:ID!,$i:ID!,$f:ID!){
      clearProjectV2ItemFieldValue(input:{projectId:$p,itemId:$i,fieldId:$f}){ projectV2Item{ id } }
    }`,
    { p: ctx.projectId, i: itemId, f: ctx.expiryFieldId },
  )
}
