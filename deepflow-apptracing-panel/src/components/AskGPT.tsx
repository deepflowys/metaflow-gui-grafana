import _ from 'lodash'
import React, { useEffect, useMemo, useRef, useState } from 'react'
import { Button, Drawer, IconButton, InlineField, Select } from '@grafana/ui'
import { getAppEvents } from '@grafana/runtime'
import { marked } from 'marked'
import { AppEvents, SelectableValue } from '@grafana/data'
import aiIcon from '../img/ai.svg'
import copy from 'copy-text-to-clipboard'

const appEvents = getAppEvents()

import './AskGPT.css'
import { findLastVisibleTextNode, getDeepFlowDatasource } from 'utils/tools'

interface Props {
  data: {
    tracing?: any[]
  }
}

const system_content = `
  你是一个应用架构方面的专家，对容器化的微服务应用有充分了解，同时熟悉k8s运维。
  我有一个应用调用链追踪的结果JSON，这个结果表明了一个应用请求如何穿过各个节点，以及各个节点对应的监控数据。
  数据的格式为一个JSON数组，其中deepflow_span_id表示当前span的id，deepflow_parent_span_id表示其父亲span的id，整个调用链通过这两个字段链接起来，如果一个span的deepflow_parent_span_id为空字符串，那么它就是初始的span。
  我们只看start_time_us、end_time_us，selftime
  , 单位都是us。这表示这个span开始时间和结束时间和自身消耗的时间。一般的，父节点的开始和结束时间都包围着子节点的开始和结束时间。
  请根据我输入的内容对这个结果进行评估，用精简的方式给出你觉得最可能有问题的资源和原因。
  额外注意如下一些问题：
  1. 如果同一个span有多个相同调用内容的子span，这一般是个循环调用，需要做下相同内容子span的计数，并作为一个问题输出，包含这个节点是谁，调用了哪个相同的子span多少次

  ---
  回答务必精简，输出内容包括：
  2. 整个调用链有哪些问题，注意给出准确的时间和数据用于说明问题
  3. 有哪些资源有突出的问题，注意给出准确的时间和数据用于说明问题
  4. 1和2中，描述问题需要把你觉得有问题的地方都列出来，尽量少省略，除非数量很多
  5. 输出一个JSON的数组，包含有问题的span的deep_flow_span_id和对应的简单文本描述。注意此项输出用纯的JSON放到输出的结尾，除此之外不要带有其他标记或者文字描述说明这是一段JSON。
  6. 用中文输出结果。对输出的结果重复检查下规则4。
  ====
  输出结果后，对结果进行重整下：
  我需要对里面的JSON二次处理，希望整句话移除这个JSON后，语句语序没有任何问题和误解。例如，不要出现 "以下是对应问题的JSON数组输出"或类似语句。将整个语句分析后，把内容输出，将JSON单独附加到结尾
`

export const AskGPT: React.FC<Props> = ({ data }) => {
  const { tracing } = data
  const [errorMsg, setErrorMsg] = useState('')
  const [visible, setVisible] = useState(false)
  const DEFAULT_STATE = {
    inRequest: false,
    answer: '',
    answerIsEnd: false
  }
  const [drawerData, setDrawerData] = useState<any>(DEFAULT_STATE)
  const onClose = () => {
    setVisible(false)
    streamerCache?.cleanup()
    streamerCache?.end()
  }

  let answerStr = ''
  let streamerCache: any = undefined
  const receiveFn = (data: { isEnd: Boolean; char: string; streamer: any }) => {
    // const { streamer } = data
    // if (!visible) {
    //   return
    // }
    const { isEnd, char, streamer } = data
    streamerCache = streamer
    if (isEnd) {
      setDrawerData({
        inRequest: false,
        answer: char,
        answerIsEnd: isEnd
      })
    } else {
      answerStr += char
      setDrawerData({
        inRequest: true,
        answer: answerStr,
        answerIsEnd: isEnd
      })
      // setTimeout(() => {
      //   console.log('@close')
      //   streamer.cleanup()
      //   streamer.end()
      // }, 2000)
    }
  }

  const answerAfterFormat = useMemo(() => {
    const answer = drawerData.answer
    const answerIsEnd = drawerData.answerIsEnd
    if (!answer) {
      return ''
    }
    let result = answer
    const jsonStartStr = '```json'
    const jsonEndStr = '```'
    const jsonStart = answer.includes(jsonStartStr)
    const jsonEnd = answer.match(/```json[\s\S]*?```/)
    if (jsonStart && jsonEnd) {
      result = result.replace(/```json[\s\S]*?```/, (e: any) => {
        const res = e.replace(jsonStartStr, '').replace(jsonEndStr, '').replace('...', '')
        let data: any
        try {
          // eslint-disable-next-line no-eval
          eval(`data = ${res}`)
          if (!Array.isArray(data)) {
            data = [data]
          }
        } catch (e) {}
        if (!data) {
          return e
        }

        return data
          .map((d: any, i: number) => {
            const { node_type } = d
            if (node_type.toLocaleLowerCase() === 'pod') {
              const prefix = window.location.href.split('/d')[0]
              const href = `${prefix}/d/Application_K8s_Pod/application-k8s-pod?orgId=1`
              return `<a style="margin: 10px 0; text-decoration: underline; color: #6e9fff; display: block;" href="${href}" target="_blank">${d.name}.json</a>`
            } else {
              return `<pre style="margin: 10px 0;">${Object.keys(d)
                .map(e => {
                  return `${e} = ${d[e]}`
                })
                .join(', ')}</pre>`
            }
          })
          .join('')
      })
    } else if (jsonStart && !jsonEnd) {
      result = result.includes(jsonStartStr) ? result.split(jsonStartStr)[0] : ''
    }
    const htmlText = marked.parse(result) as string
    if (answerIsEnd) {
      return htmlText
    }
    let parser = new DOMParser()
    let doc = parser.parseFromString(htmlText, 'text/html')
    let target = findLastVisibleTextNode(doc) as any
    if (!target) {
      return htmlText
    }
    let newTextElement = document.createElement('b')
    newTextElement.setAttribute('class', 'blink')
    if (target.nodeType === Node.TEXT_NODE) {
      target.parentNode.appendChild(newTextElement)
    } else {
      target.appendChild(newTextElement)
    }
    return doc.body.innerHTML
  }, [drawerData.answer, drawerData.answerIsEnd])

  useEffect(() => {
    if (!answerWrapperRef.current) {
      return
    }
    const answerWrapper = answerWrapperRef.current as HTMLElement
    if (answerAfterFormat === '') {
      if (answerWrapperRef.current) {
        answerWrapper.scrollTop = 0
      }
    } else {
      if (answerWrapperRef.current) {
        const maxScrollTop = answerWrapper.scrollHeight - answerWrapper.clientHeight
        if (answerWrapper.scrollTop !== maxScrollTop) {
          answerWrapper.scrollTop = maxScrollTop
        }
      }
    }
  }, [answerAfterFormat])

  const onStartRequestClick = async () => {
    const deepFlow = await getDeepFlowDatasource()
    if (!deepFlow) {
      return
    }

    try {
      setDrawerData({
        ...drawerData,
        answer: '',
        inRequest: true
      })
      answerStr = ''
      streamerCache = undefined
      if (!checkedAiEngine) {
        throw new Error('Please select an AI engine')
      }
      const engine = JSON.parse(checkedAiEngine)
      const postData = {
        system_content,
        user_content: JSON.stringify(tracing)
      }
      // @ts-ignore
      await deepFlow.askGPTRequest(engine, postData, receiveFn)
    } catch (error: any) {
      setDrawerData({
        ...drawerData,
        inRequest: false,
        errorMsg: error.message
      })

      setErrorMsg(`REQUEST FAILED: ${error.message}`)

      setTimeout(() => {
        setErrorMsg('')
      }, 800)
    }
  }

  useEffect(() => {
    if (errorMsg) {
      appEvents.publish({
        type: AppEvents.alertError.name,
        payload: [errorMsg]
      })
    }
  }, [errorMsg])

  const answerWrapperRef = useRef(null)

  const requestBtnText = useMemo(() => {
    if (errorMsg) {
      return 'Error'
    }
    if (drawerData.inRequest) {
      if (drawerData.answer) {
        return 'Receiving...'
      }
      return 'Requesting...'
    }
    return 'Start Request'
  }, [errorMsg, drawerData.inRequest, drawerData.answer])

  const [aiEngines, setAiEngines] = useState<any[]>([])
  const [checkedAiEngine, setCheckedAiEngine] = useState<any>('')
  const getAiEngines = async () => {
    try {
      const deepFlow = await getDeepFlowDatasource()
      if (!deepFlow) {
        throw new Error('Please check if DeepFlow datasource is enabled')
      }
      setAiEngines([])
      // @ts-ignore
      const result = await deepFlow.getAIConfigs()
      const list = Object.keys(result)
        .map((k: string) => {
          const item = result[k]
          return (
            item.engine_name?.map((engine_name: string) => {
              return {
                label: `${engine_name}${item.enable === '0' ? ' (disabled)' : ''}`,
                value: JSON.stringify({
                  platform: k,
                  engine_name
                }),
                disabled: item.enable === '0'
              }
            }) ?? []
          )
        })
        .flat()
      setAiEngines(list)
      setCheckedAiEngine(list.filter(e => !e.disabled)?.[0].value || '')
    } catch (error: any) {
      setErrorMsg(`GET ENGINES FAILED: ${error.message}`)

      setTimeout(() => {
        setErrorMsg('')
      }, 800)
    }
  }
  useEffect(() => {
    if (visible) {
      getAiEngines()
    }
  }, [visible])

  const [copyBtnIconName, setCopyBtnIconName] = useState<'copy' | 'check'>('copy')
  const copyAnswer = () => {
    if (!drawerData.answer) {
      return
    }
    copy(drawerData.answer)
    setCopyBtnIconName('check')
    setTimeout(() => {
      setCopyBtnIconName('copy')
    }, 1800)
  }

  return (
    <div>
      <Button
        size="sm"
        style={{
          position: 'fixed',
          top: '5px',
          right: '5px',
          zIndex: 9999
        }}
        tooltip="Ask GPT, support by DeepFlow"
        onClick={() => {
          setVisible(true)
        }}
      >
        Ask GPT
      </Button>
      {visible ? (
        <Drawer title="Ask GPT" onClose={onClose}>
          <div
            style={{
              display: 'flex',
              justifyContent: 'space-between',
              position: 'relative'
            }}
          >
            <div>
              <InlineField label="Engine:">
                <Select
                  width="auto"
                  options={aiEngines}
                  value={checkedAiEngine}
                  onChange={(v: any) => {
                    setCheckedAiEngine(v.value)
                  }}
                  placeholder="Select an AI engine"
                  noOptionsMessage="No Engines"
                  isOptionDisabled={(option: SelectableValue<any>) => option.disabled}
                />
              </InlineField>
            </div>
            <Button
              style={{
                display: 'flex',
                justifyContent: 'center',
                pointerEvents: drawerData.inRequest ? 'none' : 'auto'
              }}
              onClick={onStartRequestClick}
              icon={drawerData.inRequest ? 'fa fa-spinner' : 'info'}
              variant={errorMsg !== '' ? 'destructive' : drawerData.inRequest ? 'secondary' : 'primary'}
            >
              {requestBtnText}
            </Button>
            <img
              src={aiIcon}
              style={{
                width: '16px',
                height: '16px',
                position: 'absolute',
                right: '110px',
                top: '7px',
                opacity: drawerData.inRequest ? 0 : 1
              }}
            />
          </div>
          <section
            ref={answerWrapperRef}
            style={{
              height: 'calc(100% - 42px)',
              marginTop: '10px',
              overflow: 'auto'
            }}
          >
            {drawerData.answer !== '' && !drawerData.inRequest ? (
              <IconButton
                onClick={copyAnswer}
                aria-label="Copy"
                name={copyBtnIconName}
                style={{
                  width: '16px',
                  height: '16px',
                  position: 'sticky',
                  left: '100%',
                  top: '4px'
                }}
              />
            ) : null}
            <div className="answer-content" dangerouslySetInnerHTML={{ __html: answerAfterFormat }} />
          </section>
        </Drawer>
      ) : null}
    </div>
  )
}
